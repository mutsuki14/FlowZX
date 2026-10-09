/**
 * 流量统计服务：代理运行时经 sing-box 1.14 管理 API（gRPC）订阅 Status / Connections 流，算累计/速率/连接数。
 * 本类现运行于 stats utilityProcess（#225），经 onStats/onConnections 回调把帧 post 给 StatsWorkerHost；后者
 * relay EVENT_STATS_UPDATED（流量）/ EVENT_CONNECTIONS_AGGREGATE（host 侧聚合后的拓扑数据，#227）给渲染端。
 * 仅读取、不影响代理；流断开静默（客户端内部 2s 重连）。
 *
 * §3-B：取代旧 clash_api `/connections` 每秒轮询。速率（uplink/downlink）由 server 直接给出（无需本地 delta/dt 自算）；
 * 连接以事件流（NEW/UPDATE/CLOSED 增量 + reset 全量重置）维护一份 map，避免每秒拉全量连接列表。
 */
import type { TrafficStats, ConnectionEntry, ConnectionsSnapshot } from '../../shared/types';
import type {
  SingBoxApiClient,
  SingBoxStatus,
  SingBoxConnection,
  SingBoxConnectionEvent,
  SingBoxConnectionEvents,
} from './singbox-api-client';
import { XRAY_DIAL_INBOUND_TAG } from './xray-bridge';

// 流推送间隔：1s（纳秒，int64）。对齐旧轮询 1s 节奏（首页速率/连接数体感）。
const STATUS_INTERVAL_NS = 1_000_000_000;
const CONNECTIONS_INTERVAL_NS = 1_000_000_000;
// OOM 安全网（审计 #3）：sing-box 系统性漏发 CLOSED（UDP/QUIC NAT 超时回收高发）时 connMap 漏删条目单调累积。
// 正常活跃连接数 << 此值；仅异常累积时硬上限驱逐最旧条目兜底防 OOM。刻意不用 TTL 清扫——会误清合法长连接
// （VPN/大下载 > TTL 仍活，被删后 UPDATE 帧 connection=null 无法补建 → 丢到下次 reset），size 上限更安全。
const MAX_CONN_MAP_SIZE = 50_000;
// gRPC 长流周期重建（issue #210 根因 #3）：Status/Connections 流不间断长跑（数小时）下，grpc-js 内部
// HTTP/2 会话/通道对象可能缓慢保留（grpc-node #2068 ServerHttp2Session/channelz 类已知问题）。周期性 cancel +
// 重订阅（复用 resubscribe）使流对象不长期驻留，重连瞬断 < 1s（首帧到达即恢复），换取长会话内存稳定。
const STREAM_RESUBSCRIBE_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
// Xray 回环拨号速率的有效期：UPDATE 帧每周期（1s）一帧、无流量时不发 → 超过此时长未再收到即视为 0（防陈旧值误扣）。
const DIAL_IN_RATE_TTL_MS = 1_500;
// 已扣完的回环连接 id 记忆上限：重订阅初始帧会重放「已关闭连接历史环」（≤1000 条），据此跳过已扣过的、补扣断流期间的。
const DIAL_IN_CLOSED_MEMORY = 2_048;

/** 数值规整：string/number → number，非有限值 → undefined（避免 NaN 进 UI 差分）。 */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 拆 "ip:port"（含 IPv6 "[::1]:443"）为 { ip, port }。缺省 undefined。 */
function splitHostPort(v: unknown): { ip?: string; port?: string } {
  if (typeof v !== 'string' || v === '') return {};
  const s = v.trim();
  // IPv6 字面量带方括号："[2001:db8::1]:443"
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close > 0) {
      const ip = s.slice(1, close);
      const rest = s.slice(close + 1);
      const port = rest.startsWith(':') ? rest.slice(1) : undefined;
      return { ip: ip || undefined, port: port || undefined };
    }
    return { ip: s, port: undefined };
  }
  // IPv4 / 域名："1.2.3.4:443"——按最后一个冒号拆（裸 IPv6 无方括号时无法可靠拆，退化为整体当 ip）。
  const idx = s.lastIndexOf(':');
  if (idx < 0) return { ip: s, port: undefined };
  // 多冒号且无方括号 = 裸 IPv6（无端口），整体当 ip。
  if (s.indexOf(':') !== idx) return { ip: s, port: undefined };
  return { ip: s.slice(0, idx) || undefined, port: s.slice(idx + 1) || undefined };
}

/**
 * gRPC Connection.createdAt（int64 unix 时间戳，longs=String）→ RFC3339 字符串（渲染端 formatTimeAgo 用 Date.parse）。
 * sing-box 以 unix 纳秒（time.Time.UnixNano）序列化 createdAt；启发式按数量级判 ns/us/ms/s 兼容核版本差异：
 *   ns ~1e18 / us ~1e15 / ms ~1e12 / s ~1e9（2020 后）。非法/0 → undefined（连接信息页时长列留空）。
 */
function createdAtToRfc3339(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  let ms: number;
  if (n >= 1e17)
    ms = n / 1e6; // 纳秒（sing-box 默认）
  else if (n >= 1e14)
    ms = n / 1e3; // 微秒
  else if (n >= 1e11)
    ms = n; // 毫秒
  else ms = n * 1e3; // 秒
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 裁剪 gRPC SingBoxConnection → ConnectionEntry。
 * topology 用 id/chains/rule/metadata{host,destinationIP}；连接信息页额外用
 * network/type/sourceIP/sourcePort/destinationPort/processPath + upload/download/start（速率/源/进程/时长）。
 * ⚠️ metadata 含 sourceIP/processPath 隐私字段——出 IPC 供连接信息页用，由渲染端在隐私模式下屏蔽明细（决策）。
 * 字段映射（gRPC → ConnectionEntry）：id→id, chainList→chains, rule→rule；metadata{ host←domain,
 * network←network, destinationIP/destinationPort←拆 destination, sourceIP/sourcePort←拆 source,
 * processPath←processInfo.processPath, type←inboundType }; upload←uplinkTotal, download←downlinkTotal,
 * start←createdAt(转 RFC3339)。导出供单测断言扩字段带出。
 */
export function trimConnection(c: SingBoxConnection): ConnectionEntry {
  const src = splitHostPort(c?.source);
  const dst = splitHostPort(c?.destination);
  return {
    id: String(c?.id ?? ''),
    chains: Array.isArray(c?.chainList) ? c.chainList : [],
    rule: String(c?.rule ?? ''),
    // gRPC 无 rulePayload 字段（clash 专有）；恒空串维持 ConnectionEntry 形状。
    rulePayload: '',
    metadata: {
      host: c?.domain || undefined,
      destinationIP: dst.ip,
      network: c?.network || undefined,
      type: c?.inboundType || undefined,
      sourceIP: src.ip,
      sourcePort: src.port,
      destinationPort: dst.port,
      processPath: c?.processInfo?.processPath || undefined,
    },
    upload: num(c?.uplinkTotal),
    download: num(c?.downlinkTotal),
    start: createdAtToRfc3339(c?.createdAt),
  };
}

export class StatsService {
  // Status 流 stop 句柄（常开，仅核运行期）。null=未订阅。
  private statusStop: (() => void) | null = null;
  // Connections 流 stop 句柄（订阅跟随 started）。null=未订阅。
  private connectionsStop: (() => void) | null = null;
  private snapshot: TrafficStats = {
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUpload: 0,
    totalDownload: 0,
    activeConnections: 0,
  };
  // 连接事件流维护的连接 map（key=id）。reset=true 清空重建；NEW 加 / UPDATE 改 / CLOSED 删。
  private connMap = new Map<string, SingBoxConnection>();
  private connections: ConnectionEntry[] = [];
  private started = false;
  // batch2 §3.6：Connections 上游流「需求开关」。worker 在窗口隐藏 / 无 aggregate+detail 消费者时下发 false →
  // cancel SubscribeConnections（sing-box 少序列化一条每秒长流，顺带削核 CPU 面），Status 流不受影响（流量条恒需）。
  // 默认 true，保持既有「连接流订阅跟随 started」语义；本标志同时 gate start/resubscribe/30min 周期重建里的连接
  // 订阅，使停用态不被周期重建复活（#210 周期重建仅作用活跃流，设计 §3.4-3）。
  private connectionsEnabled = true;
  // 长流周期重建定时器（issue #210 根因 #3）：见 STREAM_RESUBSCRIBE_INTERVAL_MS。null=未运行。
  private resubscribeTimer: ReturnType<typeof setInterval> | null = null;
  // Xray 回环拨号连接（入站 xray-dial-in）：Xray 节点的每个字节在 sing-box 里过两遍（应用→socks 桥出站；Xray 拨号
  // →xray-dial-in→直连/前置），Status 的速率/总量两遍都算。这些内部连接不进 connMap（连接页/计数/拓扑不显示），
  // 其字节从 Status 总量/速率里扣除。key=活跃回环连接 id → 该连接已扣字节（按快照累计值补差，不重复扣）。
  private dialIn = new Map<string, { up: number; down: number }>();
  // 已关闭且扣完的回环连接 id（插入序，上限 DIAL_IN_CLOSED_MEMORY）：重订阅初始帧重放历史环时据此不重复扣。
  private dialInClosed = new Set<string>();
  // 本核会话累计已扣字节（Status 总量是核生命周期累计）：resubscribe（新核）/ stop 归零；30min 周期重建与连接流开关不归零。
  private dialInTotal = { up: 0, down: 0 };
  // 最近一个 UPDATE 帧里回环连接的增量（UPDATE 每周期 1s 一帧 ≈ 字节/秒）+ 收到时刻 → 从 Status 速率扣除（过期作 0）。
  private dialInRate = { up: 0, down: 0, at: 0 };
  // CLOSED 快照补差的末段字节（短连接常不足一周期、根本没有 UPDATE）：下一 Status 帧从速率扣一次即清。
  private dialInBurst = { up: 0, down: 0 };

  /**
   * @param onUpdate 每次拿到新 Status 时回调（广播给渲染端）
   * @param getApiClient 取运行期管理 API 客户端（ProxyManager.getApiClient；核未起返回 null）。每次开流时取最新。
   * @param onConnections 连接快照回调（topology 统一供数；连接事件流每帧推送）
   * @param isWindowVisible 窗口可见性谓词。无可见窗口（已销毁：关窗释放内存/轻量模式，或 macOS Cmd+H
   *   系统级隐藏、普通最小化）= 无 UI 消费者 → 跳过 broadcast（含首页 stats）。缺省（未注入，如单测）=
   *   不门控、始终广播。
   */
  constructor(
    private readonly onUpdate: (stats: TrafficStats) => void,
    private readonly getApiClient: () => SingBoxApiClient | null,
    private readonly onConnections?: (snap: ConnectionsSnapshot) => void,
    private readonly isWindowVisible?: () => boolean
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.subscribeStatusStream();
    // 连接流订阅【跟随 started】（代理运行即订阅），不再依赖渲染端 watcher 计数到达时机——挂载期 watch IPC 与
    // resubscribe/started 的时序竞态曾致「启动后拓扑不自动刷新、需先点连接信息」。广播仍由窗口可见性门控
    // （onConnectionEvents 内 isWindowVisible）省无 UI 开销；watcher 计数仅作渲染端引用记录，不再 gate 订阅。
    this.subscribeConnectionsStream();
    this.startResubscribeTimer();
  }

  /**
   * 启动长流周期重建定时器（issue #210 根因 #3）。已运行则不重复启动。stop 时清理（L4：resubscribe 不触碰它）。
   * 周期触发调 resubscribeStreamsOnly（不归零快照，避免首页闪烁 M4）；崩溃/重启场景由外部调 resubscribe（归零）。
   */
  private startResubscribeTimer(): void {
    if (this.resubscribeTimer) return;
    this.resubscribeTimer = setInterval(() => {
      // 仅在仍处于运行态时重建（stop 后可能仍有在途回调）；started 守卫防停止后误触发。
      if (!this.started) return;
      this.resubscribeStreamsOnly();
    }, STREAM_RESUBSCRIBE_INTERVAL_MS);
  }

  /** 停止周期重建定时器（幂等）。 */
  private stopResubscribeTimer(): void {
    if (this.resubscribeTimer) {
      clearInterval(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
  }

  /**
   * 重订阅到「当前」api client（E-1）。崩溃自动重启路径（ProxyManager.handleProcessExit 直接 return，不经
   * emit('stopped') → 不调本服务 stop()）下 `started` 仍为 true → start() 幂等闸门直接 return → 旧 statusStop
   * 句柄仍绑死旧 client / 旧 api 端口（端口每次启动可能重解析变化），旧流即便自愈也连不回新核 → Status 流
   * （首页速率/总量/连接数）显示停滞。本方法无视幂等闸门：先停现有流句柄（旧句柄 cancel 旧 client 的流），
   * 再按新 getApiClient() 重订阅 Status（始终）+ Connections（跟随 started），即时切到新 client。
   * 同时满足首次启动（started=false）：置位 started 后等效于 start()，故 'started' 监听器统一调用本方法即可。
   */
  resubscribe(): void {
    this.started = true;
    // 停旧句柄（指向旧 client）。两条 unsubscribe 把 statusStop/connectionsStop 清 null（吞异常 cancel 旧 client 的流），
    // 否则 subscribe* 会被「已订阅」守卫（if (this.statusStop) return）短路、订阅不到新 client。
    // unsubscribeConnectionsStream 同时清 connMap/connections。
    this.unsubscribeStatusStream();
    this.unsubscribeConnectionsStream();
    // F2：snapshot 归零并广播（对齐 stop() 语义）。新核重启后 totals/speed/activeConnections 本就从 0 起；
    // 不归零则崩溃 auto-restart（不走 stop()）后，新核首帧到达前 ~1s 窗口里首页 activeConnections 显旧值、
    // 而连接列表已被 unsubscribeConnectionsStream 清空，计数/列表不一致。归零 + 广播使重连窗口状态一致。
    // 注意：周期重建（startResubscribeTimer）调 resubscribeStreamsOnly（不归零），避免首页每 30min 闪烁 0。
    this.snapshot = {
      uploadSpeed: 0,
      downloadSpeed: 0,
      totalUpload: 0,
      totalDownload: 0,
      activeConnections: 0,
    };
    this.resetDialIn(); // 新核：Status 总量从 0 起，已扣字节同步归零
    this.onUpdate({ ...this.snapshot });
    this.onConnections?.({ connections: [], at: Date.now() });
    this.subscribeStatusStream();
    this.subscribeConnectionsStream(); // 跟随 started（见 start 注释）
    // 启动长流周期重建定时器（issue #210 根因 #3 + 假绿修复）：本方法是生产唯一驱动入口
    //（index.ts 仅 proxyManager.on('api-client-ready', () => resubscribe())，从不调 start()）。
    // 若定时器只在 start() 启动，生产环境永不触发 → 周期重建失效（grpc-js 长流驻留未规避）。
    // startResubscribeTimer 幂等（已运行则 return），故崩溃重启多次 resubscribe 只持有一个定时器。
    this.startResubscribeTimer();
  }

  /**
   * 周期重建专用（issue #210 根因 #3）：仅重订阅两条流（停旧句柄 + 重新订阅），**不归零 snapshot**。
   * 与 resubscribe() 的区别：周期重建是同一核的流刷新（规避 grpc-js 长流对象驻留），速率/总量是连续值，
   * 归零会让首页每 30min 闪烁 0（M4）。旧句柄已 cancel，新核首帧到达即覆盖快照（重连瞬断 < 1s）；
   * connMap 经 unsubscribeConnectionsStream 清空重建（连接列表本就该重置，避免跨流 id 漂移）。
   */
  private resubscribeStreamsOnly(): void {
    this.unsubscribeStatusStream();
    this.unsubscribeConnectionsStream();
    // 不归零 snapshot：速率/总量是连续值，重连后首帧覆盖；归零会闪烁。
    // 但 activeConnections 重置为 connMap.size（刚清空=0），等首帧恢复——这与 resubscribe 的瞬时 0 等价，
    // 区别仅在 totals/speed 不闪。
    this.subscribeStatusStream();
    this.subscribeConnectionsStream();
  }

  stop(): void {
    this.started = false;
    this.stopResubscribeTimer();
    this.unsubscribeStatusStream();
    this.unsubscribeConnectionsStream();
    this.snapshot = {
      uploadSpeed: 0,
      downloadSpeed: 0,
      totalUpload: 0,
      totalDownload: 0,
      activeConnections: 0,
    };
    this.onUpdate({ ...this.snapshot }); // 停止即清零广播
    this.connMap.clear();
    this.connections = [];
    this.resetDialIn();
    this.onConnections?.({ connections: [], at: Date.now() }); // 停止即广播空连接快照
  }

  /**
   * batch2 §3.6：按需求开关「Connections 上游流」（Status 流不受影响，流量条恒需）。worker 在窗口隐藏 / 无
   * aggregate+detail 消费者时下发 false → cancel SubscribeConnections（sing-box 少序列化一条每秒长流、削核 CPU）；
   * true → 重订阅（connMap 重建）。复用既有 subscribe/unsubscribeConnectionsStream，不新增流原语。connectionsEnabled
   * 同时 gate 30min 周期重建里的连接订阅，故停用态不被复活（#210 周期仅作用活跃流）。started=false（未订阅）时仅存
   * 标志，下次 start/resubscribe 生效。幂等：状态未变直接返回。
   */
  setConnectionsStreamEnabled(on: boolean): void {
    if (on === this.connectionsEnabled) return;
    this.connectionsEnabled = on;
    if (!this.started) return; // 未订阅态：仅记标志，下次 subscribe 生效
    if (on) this.subscribeConnectionsStream();
    else this.unsubscribeConnectionsStream();
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    return { connections: this.connections, at: Date.now() };
  }

  /** 流 stop 句柄安全调用（吞异常）并清空：两条流退订同构，单一真值复用。返回 null 供调用方回写句柄字段。 */
  private clearStop(handle: (() => void) | null): null {
    try {
      handle?.();
    } catch {
      /* ignore */
    }
    return null;
  }

  // ── Status 流 ────────────────────────────────────────────────────────────────
  private subscribeStatusStream(): void {
    if (this.statusStop) return;
    const client = this.getApiClient();
    if (!client) return; // 核未起/无管理 API → 不开流（start 时核必已起；防御性兜底）
    this.statusStop = client.subscribeStatus(STATUS_INTERVAL_NS, (status) => this.onStatus(status));
  }

  private unsubscribeStatusStream(): void {
    this.statusStop = this.clearStop(this.statusStop);
  }

  /**
   * Status 帧处理：speed/total/连接数直接取 server 给的值（speed 已是速率，无需本地 delta/dt）。
   * 窗口不可见 → 跳过 broadcast（无 UI 消费者；快照仍更新，可见后下一帧即广播最新）。
   */
  private onStatus(status: SingBoxStatus): void {
    // 扣除 Xray 回环拨号（xray-dial-in）重复计入的字节（见 dialIn）；钳 ≥0 防两条流相位差致负值。
    const rate =
      Date.now() - this.dialInRate.at <= DIAL_IN_RATE_TTL_MS ? this.dialInRate : { up: 0, down: 0 };
    this.snapshot.uploadSpeed = Math.max(
      0,
      (num(status?.uplink) ?? 0) - rate.up - this.dialInBurst.up
    );
    this.snapshot.downloadSpeed = Math.max(
      0,
      (num(status?.downlink) ?? 0) - rate.down - this.dialInBurst.down
    );
    this.dialInBurst = { up: 0, down: 0 };
    this.snapshot.totalUpload = Math.max(0, (num(status?.uplinkTotal) ?? 0) - this.dialInTotal.up);
    this.snapshot.totalDownload = Math.max(
      0,
      (num(status?.downlinkTotal) ?? 0) - this.dialInTotal.down
    );
    // activeConnections 不取 Status 的 connectionsIn/Out——sing-box 1.14 SubscribeStatus 实测不填这俩（真机首页
    // 恒 0 而连接信息页正常）；改由 Connections 流的 connMap.size 维护（见 onConnectionEvents），此处只更速率/总量。
    if (this.isWindowVisible && !this.isWindowVisible()) return; // 无 UI 消费者 → 跳过广播
    this.onUpdate({ ...this.snapshot });
  }

  // ── Connections 流 ───────────────────────────────────────────────────────────
  private subscribeConnectionsStream(): void {
    if (!this.connectionsEnabled) return; // batch2：需求关闭时不订阅（含 start/resubscribe/30min 周期重建路径）
    if (this.connectionsStop) return;
    const client = this.getApiClient();
    if (!client) return;
    this.connMap.clear();
    this.connections = [];
    this.connectionsStop = client.subscribeConnections(CONNECTIONS_INTERVAL_NS, (events) =>
      this.onConnectionEvents(events)
    );
  }

  private unsubscribeConnectionsStream(): void {
    this.connectionsStop = this.clearStop(this.connectionsStop);
    this.connMap.clear();
    this.connections = [];
    // 回环连接的扣除记账（dialIn / dialInClosed / dialInTotal）保留：同核重订阅后初始帧按累计值补差；仅速率失效。
    this.dialInRate = { up: 0, down: 0, at: 0 };
    this.dialInBurst = { up: 0, down: 0 };
  }

  /** 回环拨号扣除状态归零（新核 / 停核）。 */
  private resetDialIn(): void {
    this.dialIn.clear();
    this.dialInClosed.clear();
    this.dialInTotal = { up: 0, down: 0 };
    this.dialInRate = { up: 0, down: 0, at: 0 };
    this.dialInBurst = { up: 0, down: 0 };
  }

  /**
   * Xray 回环拨号连接（inbound=xray-dial-in）的事件：记字节供 Status 扣除，不进 connMap。返回 true = 已处理。
   * sing-box 1.14 实测：NEW / CLOSED 即时单发且带连接快照（CLOSED 快照含终值——不足一周期的末段字节只在这里），
   * UPDATE 每周期一帧只带 delta。故 NEW/CLOSED 按快照累计值补差、UPDATE 按 delta 记：补差使同核重订阅后再见同一
   * 连接只扣期间增量。初始帧重放的历史环（NEW 且 closedAt>0）：扣完过的（dialInClosed）跳过，没见过的（断流期间
   * 开且关）按终值补扣。
   */
  private trackDialIn(
    ev: SingBoxConnectionEvent,
    id: string,
    seen: Set<string> | null,
    rate: { up: number; down: number }
  ): boolean {
    const known = this.dialIn.get(id);
    const c = ev?.connection;
    if (!known && c?.inbound !== XRAY_DIAL_INBOUND_TAG) return false;
    if (!known && this.dialInClosed.has(id)) return true; // 已扣完的连接被历史环重放
    const e = known ?? { up: 0, down: 0 };
    let up: number;
    let down: number;
    if (ev?.type === 'UPDATE' || !c) {
      up = Number(ev?.uplinkDelta) || 0;
      down = Number(ev?.downlinkDelta) || 0;
      if (ev?.type === 'UPDATE') {
        rate.up += up;
        rate.down += down;
      }
    } else {
      up = Math.max(0, (Number(c.uplinkTotal) || 0) - e.up);
      down = Math.max(0, (Number(c.downlinkTotal) || 0) - e.down);
      // 实时 CLOSED 的末段字节刚流过 → 计入速率扣除；NEW 补差（含历史环重放）是断流期间的旧字节，只扣总量。
      if (ev?.type === 'CLOSED') {
        this.dialInBurst.up += up;
        this.dialInBurst.down += down;
      }
    }
    e.up += up;
    e.down += down;
    this.dialInTotal.up += up;
    this.dialInTotal.down += down;
    if (ev?.type === 'CLOSED' || Number(c?.closedAt) > 0) {
      this.dialIn.delete(id);
      this.dialInClosed.add(id);
      if (this.dialInClosed.size > DIAL_IN_CLOSED_MEMORY) {
        this.dialInClosed.delete(this.dialInClosed.values().next().value as string);
      }
    } else {
      this.dialIn.set(id, e);
      seen?.add(id);
    }
    return true;
  }

  /**
   * Connections 事件帧处理：reset=true → 清空 map 按 events 全量重建；否则增量（NEW 加/UPDATE 改/CLOSED 删）。
   * 维护后映射成 ConnectionEntry 列表广播。窗口不可见跳过 broadcast（map 仍维护，可见后下帧即推）。
   */
  private onConnectionEvents(events: SingBoxConnectionEvents): void {
    if (events?.reset) this.connMap.clear();
    // reset 帧 = 全量（含历史环）：本帧未出现的活跃回环连接已关闭且滚出历史环 → 停止跟踪（末段字节无从得知）。
    const seenDialIn = events?.reset ? new Set<string>() : null;
    const rate = { up: 0, down: 0 };
    let hasUpdate = false;
    for (const ev of events?.events ?? []) {
      const id = ev?.id ?? ev?.connection?.id;
      if (!id) continue;
      if (ev?.type === 'UPDATE') hasUpdate = true;
      // Xray 回环拨号连接：只记字节供 Status 扣除，不进 connMap（不计连接数、不进连接页/拓扑）。
      if (this.trackDialIn(ev, id, seenDialIn, rate)) continue;
      switch (ev?.type) {
        case 'CLOSED':
          this.connMap.delete(id);
          break;
        case 'UPDATE': {
          // 实测：UPDATE 帧只带 uplinkDelta/downlinkDelta（connection 为 null）→ 把增量累加到既有条目 totals，
          // 维持连接页 per-connection 实时流量（否则恒显 NEW 时的 0，到 CLOSED 又被删，全程流量为 0=regression）。
          // 漏收 NEW（UPDATE 先到）时 ev.connection 兜底补建。
          // 缺失/keepalive 帧的 delta 缺省按 0 累积，故用 `|| 0` 而非 num()——num() 会把缺失字段算成 NaN，
          // 一次 NaN 会污染 totals 此后恒 NaN（累积语义被毁），`|| 0`（同 falsy→0）才是累积所需的正确兜底。
          const existing = this.connMap.get(id);
          if (existing) {
            existing.uplinkTotal = String(
              (Number(existing.uplinkTotal) || 0) + (Number(ev.uplinkDelta) || 0)
            );
            existing.downlinkTotal = String(
              (Number(existing.downlinkTotal) || 0) + (Number(ev.downlinkDelta) || 0)
            );
            // LRU 近似（#167 OOM eviction 删错对象修复）：JS Map 迭代序=插入序，活跃长连接仅走 UPDATE 帧
            // （只改 totals 字段、不 re-set）会永远停在最早插入位 → 超上限 eviction(keys().next())恰删掉注释
            // 声称要保护的健康长连接，而非真正漏删的死连接。delete+set 把刚收到 UPDATE 的活跃条目移到插入序末尾，
            // 使迭代序首部恒为「最久未更新」条目（最可能是漏发 CLOSED 的死连接），eviction 删的才是该删的。
            this.connMap.delete(id);
            this.connMap.set(id, existing);
          } else if (ev?.connection) {
            this.connMap.set(id, ev.connection);
          }
          break;
        }
        case 'NEW':
        default:
          // sing-box 1.14 SubscribeConnections 的初始/重置帧会把「已关闭连接历史环」（最近 ≤1000 条死连接，含刚被
          // 切换杀掉的整批旧节点连接）作为 NEW 下发，仅 closedAt>0 可区分；这些死连接不进服务端 snapshots → 永不补发
          // CLOSED。若照收入 map 即成永久幽灵（连接页/首页拓扑显示已死的旧节点连线、上下行数值冻结，看着像"切换未断连"）。
          // 故 NEW 丢弃 closedAt>0 条目：只留活连接。附带根治 connMap 死连接单调累积（审计 #3）。
          if (ev?.connection && !(Number(ev.connection.closedAt) > 0)) {
            this.connMap.set(id, ev.connection);
          }
          break;
      }
    }
    // OOM 安全网（审计 #3）：超硬上限按插入顺序（JS Map 迭代序=最早插入、最可能是漏删的死连接）驱逐最旧，
    // 不依赖上游 CLOSED 事件完整性。正常 connMap.size << 上限，此循环不触发。
    while (this.connMap.size > MAX_CONN_MAP_SIZE) {
      const oldest = this.connMap.keys().next().value;
      if (oldest === undefined) break;
      this.connMap.delete(oldest);
    }
    if (seenDialIn) {
      for (const id of this.dialIn.keys()) if (!seenDialIn.has(id)) this.dialIn.delete(id);
    }
    // 同一 OOM 安全网（漏发 CLOSED 的回环连接）：按插入序驱逐最旧。
    while (this.dialIn.size > MAX_CONN_MAP_SIZE) {
      const oldest = this.dialIn.keys().next().value;
      if (oldest === undefined) break;
      this.dialIn.delete(oldest);
    }
    // 速率只认 UPDATE 帧（每周期一帧、含全部有流量连接的 delta）；NEW/CLOSED 单发帧不覆盖。
    if (hasUpdate) this.dialInRate = { ...rate, at: Date.now() };
    // 活动连接数由本流的 connMap.size 维护（Status 的 connectionsIn/Out 核不填 → 首页恒 0 的根因）；在可见性
    // 短路前更新，使下一次 Status onUpdate 广播到的计数恒为真实活跃连接数。
    this.snapshot.activeConnections = this.connMap.size;
    // 不可见（无 UI 消费者）→ 只维护 connMap、跳过列表物化 + 广播（省每秒对全部连接的全量重建 + splitHostPort，
    // 结果本就被可见性门控丢弃）；可见后下一帧即物化推送。
    if (this.isWindowVisible && !this.isWindowVisible()) return;
    this.connections = Array.from(this.connMap.values()).map(trimConnection);
    this.onConnections?.({ connections: this.connections, at: Date.now() });
  }
}
