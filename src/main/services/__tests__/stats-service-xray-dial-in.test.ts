/**
 * StatsService × Xray 回环拨号（xray-dial-in）：Xray 节点的字节在 sing-box 里过两遍（应用→socks 桥；Xray 拨号→
 * xray-dial-in→直连/前置），Status 速率/总量会翻倍、连接页多出 xray 进程的内部连接。
 *
 * 事件形态按 sing-box 1.14 实测（真核 + 回环 socks 复现）构造：
 *  - 订阅首帧 reset=true；NEW / CLOSED 即时单发且带连接快照（CLOSED 快照含终值、delta 为 0）；
 *  - UPDATE 每周期一帧（所有有流量连接的 delta，connection 为空）；
 *  - 连接流重订阅时 reset 帧重放「已关闭连接历史环」（NEW 且 closedAt>0）。
 * 本套锁：① 回环连接不进列表 / 不计数；② 总量扣除精确（含不足一周期的短连接、断流期间的连接）；
 * ③ 速率扣 UPDATE 增量（过期作 0）+ CLOSED 末段（扣一次）；④ 历史环重放不重复扣；⑤ 新核归零。
 */
import { StatsService } from '../StatsService';
import { XRAY_DIAL_INBOUND_TAG } from '../xray-bridge';
import type { TrafficStats, ConnectionsSnapshot } from '../../../shared/types';
import type {
  SingBoxApiClient,
  SingBoxStatus,
  SingBoxConnection,
  SingBoxConnectionEvents,
} from '../singbox-api-client';

// start() 起 30min 周期重建定时器 → 每例 stop() 清理，避免 jest worker 挂着定时器不退出。
const started: StatsService[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.stop();
  jest.restoreAllMocks();
});

function setup() {
  let statusCb: ((s: SingBoxStatus) => void) | null = null;
  let connCb: ((e: SingBoxConnectionEvents) => void) | null = null;
  const client = {
    subscribeStatus: jest.fn((_ns: number, cb: (s: SingBoxStatus) => void) => {
      statusCb = cb;
      return () => {
        statusCb = null;
      };
    }),
    subscribeConnections: jest.fn((_ns: number, cb: (e: SingBoxConnectionEvents) => void) => {
      connCb = cb;
      return () => {
        connCb = null;
      };
    }),
  } as unknown as SingBoxApiClient;
  const onUpdate = jest.fn<void, [TrafficStats]>();
  const onConnections = jest.fn<void, [ConnectionsSnapshot]>();
  const service = new StatsService(onUpdate, () => client, onConnections);
  service.start();
  started.push(service);
  connCb!({ reset: true, events: [] }); // 订阅首帧（实测 reset=true）
  return {
    service,
    pushStatus: (s: SingBoxStatus) => statusCb?.(s),
    pushConn: (e: SingBoxConnectionEvents) => connCb?.(e),
    lastStats: (): TrafficStats => onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0],
    lastConns: (): ConnectionsSnapshot =>
      onConnections.mock.calls[onConnections.mock.calls.length - 1][0],
  };
}

const status = (up: number, down: number, upTotal: number, downTotal: number): SingBoxStatus => ({
  uplink: String(up),
  downlink: String(down),
  uplinkTotal: String(upTotal),
  downlinkTotal: String(downTotal),
});

const conn = (
  id: string,
  inbound: string,
  up = 0,
  down = 0,
  closedAt = '0'
): SingBoxConnection => ({
  id,
  inbound,
  inboundType: inbound === XRAY_DIAL_INBOUND_TAG ? 'socks' : 'mixed',
  network: 'tcp',
  destination: '203.0.113.7:443',
  chainList: inbound === XRAY_DIAL_INBOUND_TAG ? ['xray-dial-direct'] : ['proxy-selector', 'x'],
  uplinkTotal: String(up),
  downlinkTotal: String(down),
  closedAt,
});
const dial = (id: string, up = 0, down = 0, closedAt = '0') =>
  conn(id, XRAY_DIAL_INBOUND_TAG, up, down, closedAt);
const app = (id: string, up = 0, down = 0, closedAt = '0') =>
  conn(id, 'mixed-in', up, down, closedAt);
const NEW = (c: SingBoxConnection) => ({ type: 'NEW', id: c.id, connection: c });
const CLOSED = (c: SingBoxConnection) => ({ type: 'CLOSED', id: c.id, connection: c });
const UPDATE = (id: string, up: number, down: number) => ({
  type: 'UPDATE',
  id,
  uplinkDelta: String(up),
  downlinkDelta: String(down),
});

describe('StatsService × xray-dial-in 回环拨号', () => {
  it('长连接：不进列表 / 不计数；UPDATE 增量扣速率，CLOSED 终值快照补齐末段', () => {
    const t = setup();
    t.pushConn({ events: [NEW(app('app-1'))] });
    t.pushConn({ events: [NEW(dial('dial-1'))] });
    expect(t.lastConns().connections.map((c) => c.id)).toEqual(['app-1']);

    // 同一份 1000/2000 字节过两遍：Status 报 2000/4000。
    t.pushConn({ events: [UPDATE('dial-1', 1000, 2000), UPDATE('app-1', 1000, 2000)] });
    t.pushStatus(status(2000, 4000, 2000, 4000));
    expect(t.lastStats()).toMatchObject({
      uploadSpeed: 1000,
      downloadSpeed: 2000,
      totalUpload: 1000,
      totalDownload: 2000,
      activeConnections: 1,
    });
    expect(t.lastConns().connections[0]).toMatchObject({ upload: 1000, download: 2000 });

    // 关闭：末段 500 字节只在 CLOSED 快照里（delta 为 0）——总量补扣，速率扣一次。
    t.pushConn({ events: [CLOSED(app('app-1', 1000, 2500, '1'))] });
    t.pushConn({ events: [CLOSED(dial('dial-1', 1000, 2500, '1'))] });
    t.pushStatus(status(0, 1000, 2000, 5000));
    expect(t.lastStats()).toMatchObject({
      downloadSpeed: 0, // 1000 - UPDATE 速率 2000（未过期）- 末段 500 → 钳 0
      totalUpload: 1000,
      totalDownload: 2500,
      activeConnections: 0,
    });
  });

  it('不足一周期的短连接（只有 NEW→CLOSED、没有 UPDATE）：总量与速率都按 CLOSED 终值扣', () => {
    const t = setup();
    t.pushConn({ events: [NEW(app('a'))] });
    t.pushConn({ events: [NEW(dial('d'))] });
    t.pushConn({ events: [CLOSED(app('a', 79, 3000128, '1'))] });
    t.pushConn({ events: [CLOSED(dial('d', 79, 3000128, '1'))] });
    t.pushStatus(status(158, 6000256, 158, 6000256));
    expect(t.lastStats()).toMatchObject({
      uploadSpeed: 79,
      downloadSpeed: 3000128,
      totalUpload: 79,
      totalDownload: 3000128,
    });
    // 末段只扣一次：下一帧速率不再被扣。
    t.pushStatus(status(10, 20, 168, 6000276));
    expect(t.lastStats()).toMatchObject({ uploadSpeed: 10, downloadSpeed: 20 });
  });

  it('速率只认 UPDATE 帧且会过期：NEW/CLOSED 单发帧不覆盖；超过 TTL 未再收到 UPDATE → 不再扣', () => {
    const t = setup();
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    t.pushConn({ events: [NEW(dial('d'))] });
    t.pushConn({ events: [UPDATE('d', 0, 800)] });
    t.pushConn({ events: [NEW(app('a'))] }); // 单发 NEW 帧：不得把回环速率清成 0
    t.pushStatus(status(0, 1600, 0, 1600));
    expect(t.lastStats().downloadSpeed).toBe(800);

    now += 5_000; // 回环连接空闲、无 UPDATE 帧 → 陈旧速率不得继续扣别的流量
    t.pushStatus(status(0, 700, 0, 2300));
    expect(t.lastStats()).toMatchObject({ downloadSpeed: 700, totalDownload: 1500 });
  });

  it('漏收 NEW 时 UPDATE 自带 connection 也识别为回环连接（不补建进列表）', () => {
    const t = setup();
    t.pushConn({ events: [{ ...UPDATE('dial-x', 300, 700), connection: dial('dial-x') }] });
    t.pushStatus(status(600, 1400, 600, 1400));
    expect(t.lastStats()).toMatchObject({ totalUpload: 300, totalDownload: 700 });
    expect(t.lastConns().connections).toEqual([]);
  });

  it('连接流断流后重订阅：reset 帧按累计值补差、历史环里扣过的不重扣、断流期间开且关的补扣', () => {
    const t = setup();
    t.pushConn({ events: [NEW(dial('live'))] });
    t.pushConn({ events: [NEW(dial('done'))] });
    t.pushConn({ events: [UPDATE('live', 0, 100), UPDATE('done', 0, 400)] });
    t.pushConn({ events: [CLOSED(dial('done', 0, 500, '1'))] }); // 扣满 500
    t.pushConn({ events: [NEW(dial('gone'))] }); // 断流期间关闭、且已滚出历史环

    // 窗口隐藏 → 连接流停用；期间 live 又传 50、gap 开且关传了 300。恢复后 reset 帧重放。
    t.service.setConnectionsStreamEnabled(false);
    t.service.setConnectionsStreamEnabled(true);
    t.pushConn({
      reset: true,
      events: [
        NEW(dial('live', 0, 150)),
        NEW(dial('done', 0, 500, '1')), // 历史环：已扣满 → 跳过
        NEW(dial('gap', 0, 300, '1')), // 历史环：没见过 → 按终值补扣
      ],
    });
    // 断流期间 Status 照算两遍：真实 150 + 500 + 300 = 950，Status 报 1900。
    t.pushStatus(status(0, 0, 0, 1900));
    expect(t.lastStats().totalDownload).toBe(950);
    const dialIn = (t.service as unknown as { dialIn: Map<string, unknown> }).dialIn;
    expect([...dialIn.keys()]).toEqual(['live']); // gone 不在 reset 帧 → 停止跟踪
    expect(t.lastConns().connections).toEqual([]);
  });

  it('新核（resubscribe）扣除归零；扣除量超过 Status 时钳到 0', () => {
    const t = setup();
    t.pushConn({ events: [NEW(dial('d', 5000, 5000))] });
    t.pushStatus(status(0, 0, 3000, 3000));
    expect(t.lastStats()).toMatchObject({ totalUpload: 0, totalDownload: 0 });

    t.service.resubscribe();
    t.pushStatus(status(10, 20, 100, 200));
    expect(t.lastStats()).toMatchObject({
      uploadSpeed: 10,
      downloadSpeed: 20,
      totalUpload: 100,
      totalDownload: 200,
    });
  });
});
