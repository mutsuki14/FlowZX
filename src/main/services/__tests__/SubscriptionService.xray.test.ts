/**
 * Xray JSON 订阅（node env，mock electron + dns；fetch 走 safeRedirectFetch 真实路径 + 桩响应）。覆盖：
 *  - 三形态：单份配置 {outbounds} / v2ray-json 配置数组（Marzban·3x-ui）/ 裸 outbound 数组；
 *  - remarks 命名、链式代理只在同一配置内解析、内部 outbound 忽略、subscriptionId 归属；
 *  - 0 节点 throw + 预检分类 empty；体积上限沿用；
 *  - 对账：两次更新（解析期 id 每次不同、配置顺序打乱）→ id / detour 稳定、contentChanged=false（不打断）；
 *    同 host:port 的并列透传节点按凭据区分；
 *  - 既有格式（sing-box type / JSON·YAML Clash / Base64 链接）探测不变，不被误判为 Xray。
 */

// ── electron mock（必须在 import SubscriptionService 之前）──────────────────────
const mockFetch = jest.fn();
jest.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
  net: { fetch: (...a: unknown[]) => mockFetch(...a) },
  session: {
    fromPartition: () => ({
      setProxy: jest.fn().mockResolvedValue(undefined),
      fetch: (...a: unknown[]) => mockFetch(...a),
    }),
  },
}));

const mockLookup = jest.fn();
jest.mock('dns', () => ({
  promises: { lookup: (...a: unknown[]) => mockLookup(...a) },
}));

import { SubscriptionService } from '../SubscriptionService';
import { ProtocolParser } from '../ProtocolParser';
import type { ServerConfig } from '../../../shared/types';
import { requiresXrayCore } from '../../../shared/xray';
import {
  V2RAY_JSON_NODE_NAMES,
  XRAY_SUB_UUID,
  v2rayJsonSubscription,
} from './xray-subscription-fixtures';

const SUB_ID = 'sub-xray';
const URL = 'https://sub.example.com/sub/token/v2ray-json';

class FakeLog {
  entries: { level: string; message: string }[] = [];
  addLog(level: string, message: string) {
    this.entries.push({ level, message });
  }
  text(level: string): string {
    return this.entries
      .filter((e) => e.level === level)
      .map((e) => e.message)
      .join('\n');
  }
}

function makeResponse(body: string, headers: Record<string, string> = {}): unknown {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: 200,
    ok: true,
    headers: { get: (k: string) => map.get(k.toLowerCase()) ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    async text() {
      return body;
    },
  };
}

function serve(body: unknown): void {
  mockFetch.mockResolvedValue(makeResponse(typeof body === 'string' ? body : JSON.stringify(body)));
}

function newService(log: FakeLog): SubscriptionService {
  return new SubscriptionService(new ProtocolParser(), log as never);
}

const byName = (servers: ServerConfig[]) => Object.fromEntries(servers.map((s) => [s.name, s]));

/** 模拟落盘再读回（saveConfig → JSON → loadConfig），对账的「旧侧」恒来自磁盘。 */
const persist = (servers: ServerConfig[]): ServerConfig[] => JSON.parse(JSON.stringify(servers));

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('Xray JSON 订阅 — 三形态', () => {
  it('v2ray-json 配置数组：节点名取 remarks、内部 outbound 忽略、链在同一配置内解析、归属订阅', async () => {
    const log = new FakeLog();
    serve(v2rayJsonSubscription());
    const r = await newService(log).fetchSubscription(URL, SUB_ID);

    expect(r.servers.map((s) => s.name)).toEqual(V2RAY_JSON_NODE_NAMES);
    expect(r.servers.every((s) => s.subscriptionId === SUB_ID)).toBe(true);
    const n = byName(r.servers);
    expect(n['🇭🇰 HK Reality']).toMatchObject({
      protocol: 'vless',
      address: 'hk.example.com',
      uuid: XRAY_SUB_UUID.hk,
      flow: 'xtls-rprx-vision',
      security: 'reality',
    });
    expect(n['🇯🇵 JP VMess-WS']).toMatchObject({ protocol: 'vmess', network: 'ws' });
    // 同配置内 dialerProxy → detour
    expect(n['🇺🇸 US · proxy'].detour).toBe(n['🇺🇸 US · relay'].id);
    // 透传：mKCP / 3x-ui sockopt → 自定义 Xray 节点；fragment(freedom) 前置不是节点 → 不设 detour
    for (const name of ['KCP A', 'KCP B', '3x-ui 分片']) {
      expect(n[name].protocol).toBe('custom');
      expect(n[name].customSettings?.engine).toBe('xray');
    }
    expect(n['3x-ui 分片'].detour).toBeUndefined();
    expect(n['XHTTP ENC']).toMatchObject({ protocol: 'vless', network: 'xhttp' });
    expect(requiresXrayCore(n['XHTTP ENC'])).toBe(true);
    // 内部 outbound（direct / block / fragment）不成节点
    expect(r.servers.some((s) => /direct|block|fragment/.test(s.name))).toBe(false);

    expect(log.text('info')).toMatch(/检测到 Xray JSON 格式（7 份配置）/);
    expect(log.text('info')).toMatch(/成功从 Xray 订阅解析了 8 个节点/);
    const warns = log.text('warn');
    expect(warns).toMatch(/节点「3x-ui 分片」的链式代理前置「fragment」不是已导入的节点/);
    expect(warns).toMatch(/3 个节点以「自定义 Xray JSON」原样导入/);
    expect(warns).not.toMatch(/sing-box/);
  });

  it('单份配置 {remarks, outbounds}：单节点 → 名 = remarks', async () => {
    const log = new FakeLog();
    const [jp] = v2rayJsonSubscription().slice(1, 2);
    serve(jp);
    const r = await newService(log).fetchSubscription(URL, SUB_ID);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]).toMatchObject({ name: '🇯🇵 JP VMess-WS', subscriptionId: SUB_ID });
    expect(log.text('info')).toMatch(/检测到 Xray JSON 格式（单份配置）/);
  });

  it('裸 outbound 数组：按 tag 命名，链在数组内解析', async () => {
    const log = new FakeLog();
    const us = v2rayJsonSubscription()[2] as { outbounds: Record<string, unknown>[] };
    serve(us.outbounds);
    const r = await newService(log).fetchSubscription(URL, SUB_ID);
    expect(r.servers.map((s) => s.name)).toEqual(['proxy', 'relay']);
    expect(r.servers[0].detour).toBe(r.servers[1].id);
    expect(log.text('info')).toMatch(/检测到 Xray JSON 格式（outbound 数组）/);
  });

  it('只有内部 outbound → throw「0 个可用节点」（防 reconcile 删光）；预检分类 empty', async () => {
    const body = [{ remarks: 'x', outbounds: [{ protocol: 'freedom', tag: 'direct' }] }];
    serve(body);
    await expect(newService(new FakeLog()).fetchSubscription(URL, SUB_ID)).rejects.toThrow(
      /Xray 订阅解析得到 0 个可用节点/
    );
    serve(body);
    const p = await newService(new FakeLog()).previewSubscription(URL, {});
    expect(p).toMatchObject({ ok: false, errorKind: 'empty' });
  });

  it('预检成功 → nodeCount 与正式拉取一致', async () => {
    serve(v2rayJsonSubscription());
    const p = await newService(new FakeLog()).previewSubscription(URL, {});
    expect(p).toEqual({ ok: true, nodeCount: V2RAY_JSON_NODE_NAMES.length });
  });

  it('体积上限沿用（content-length 预检超限 → 拒绝，不解析）', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(JSON.stringify(v2rayJsonSubscription()), {
        'content-length': String(11 * 1024 * 1024),
      })
    );
    await expect(newService(new FakeLog()).fetchSubscription(URL, SUB_ID)).rejects.toThrow(
      /超过上限/
    );
  });
});

describe('Xray JSON 订阅 — 对账稳定性（更新不打断）', () => {
  it('两次更新（解析期 id 不同 + 配置顺序打乱）→ 全部命中旧 id、detour 指旧前置 id、contentChanged=false', async () => {
    const svc = newService(new FakeLog());
    serve(v2rayJsonSubscription());
    const first = await svc.fetchSubscription(URL, SUB_ID);
    const r1 = SubscriptionService.reconcileServers([], first.servers, 'T1');
    expect(r1.added).toBe(V2RAY_JSON_NODE_NAMES.length);
    const stored = persist(r1.servers);
    const storedByName = byName(stored);
    // 首次入库：detour 指向本批前置（未被重映射成悬空 id）
    expect(storedByName['🇺🇸 US · proxy'].detour).toBe(storedByName['🇺🇸 US · relay'].id);

    serve([...v2rayJsonSubscription()].reverse());
    const second = await svc.fetchSubscription(URL, SUB_ID);
    // 解析期 id 每次随机：不对账就全变
    const secondIds = new Set(second.servers.map((s) => s.id));
    expect(stored.some((s) => secondIds.has(s.id))).toBe(false);

    const r2 = SubscriptionService.reconcileServers(stored, second.servers, 'T2');
    expect(r2).toMatchObject({ added: 0, deleted: 0, contentChanged: false });
    expect(r2.updated).toBe(V2RAY_JSON_NODE_NAMES.length);
    const after = byName(r2.servers);
    for (const name of V2RAY_JSON_NODE_NAMES) {
      expect(after[name].id).toBe(storedByName[name].id);
      // 内容未变 → 不刷 updatedAt（不投毒热切换）
      expect(after[name].updatedAt).toBe(storedByName[name].updatedAt);
    }
    expect(after['🇺🇸 US · proxy'].detour).toBe(storedByName['🇺🇸 US · relay'].id);
    // 同 host:port 的两个 mKCP 透传节点按 UUID 区分，顺序颠倒也不互换 id
    expect(after['KCP A'].customSettings?.outbound).toEqual(
      storedByName['KCP A'].customSettings?.outbound
    );
    expect(after['KCP B'].id).toBe(storedByName['KCP B'].id);

    // 第三次（同内容）仍零变化——稳定是不动点，不是一次性的
    serve(v2rayJsonSubscription());
    const third = await svc.fetchSubscription(URL, SUB_ID);
    const r3 = SubscriptionService.reconcileServers(persist(r2.servers), third.servers, 'T3');
    expect(r3).toMatchObject({ added: 0, deleted: 0, contentChanged: false });
  });

  it('前置换凭据（指纹变 → 删旧增新）→ 链改指新前置 id；出口自身改路径 → 原地更新保 id', async () => {
    const svc = newService(new FakeLog());
    serve(v2rayJsonSubscription());
    const stored = persist(
      SubscriptionService.reconcileServers(
        [],
        (await svc.fetchSubscription(URL, SUB_ID)).servers,
        'T1'
      ).servers
    );
    const storedByName = byName(stored);

    const next = v2rayJsonSubscription() as any[];
    next[2].outbounds[1].settings.servers[0].password = 'pw-relay-2'; // relay 换密码
    next[1].outbounds[0].streamSettings.wsSettings.path = '/vm2'; // JP 改 ws path
    serve(next);
    const r = SubscriptionService.reconcileServers(
      stored,
      (await svc.fetchSubscription(URL, SUB_ID)).servers,
      'T2'
    );
    expect(r).toMatchObject({ added: 1, deleted: 1, contentChanged: true });
    const after = byName(r.servers);
    expect(r.deletedIds.has(storedByName['🇺🇸 US · relay'].id)).toBe(true);
    expect(after['🇺🇸 US · relay'].id).not.toBe(storedByName['🇺🇸 US · relay'].id);
    expect(after['🇺🇸 US · proxy'].id).toBe(storedByName['🇺🇸 US · proxy'].id);
    expect(after['🇺🇸 US · proxy'].detour).toBe(after['🇺🇸 US · relay'].id);
    expect(after['🇺🇸 US · proxy'].updatedAt).toBe('T2'); // detour 变了 → 内容变
    expect(after['🇯🇵 JP VMess-WS'].id).toBe(storedByName['🇯🇵 JP VMess-WS'].id);
    expect(after['🇯🇵 JP VMess-WS'].wsSettings?.path).toBe('/vm2');
    expect(after['🇯🇵 JP VMess-WS'].updatedAt).toBe('T2');
    expect(after['🇭🇰 HK Reality'].updatedAt).toBe(storedByName['🇭🇰 HK Reality'].updatedAt);
    // 所有 detour 都指向本订阅存活节点（无悬空）
    const ids = new Set(r.servers.map((s) => s.id));
    expect(r.servers.filter((s) => s.detour).every((s) => ids.has(s.detour!))).toBe(true);
  });

  it('serverFingerprint：透传 Xray 节点展开内层凭据/传输；sing-box 自定义节点口径不变', () => {
    const custom = (outbound: Record<string, unknown>, engine?: 'xray'): ServerConfig =>
      ({
        id: 'x',
        name: 'x',
        protocol: 'custom',
        address: 'k.com',
        port: 1,
        customSettings: { outbound, ...(engine ? { engine } : {}) },
      }) as ServerConfig;
    const kcp = (id: string) => ({
      protocol: 'vless',
      settings: { vnext: [{ address: 'k.com', port: 1, users: [{ id }] }] },
      streamSettings: { network: 'kcp' },
    });
    const fa = SubscriptionService.serverFingerprint(custom(kcp('a'), 'xray'));
    const fb = SubscriptionService.serverFingerprint(custom(kcp('b'), 'xray'));
    expect(fa).toBe('custom:vless|k.com|1|a|kcp');
    expect(fa).not.toBe(fb);
    expect(SubscriptionService.serverFingerprint(custom({ type: 'tor' }))).toBe(
      'custom|k.com|1||tcp'
    );
  });

  it('reconcile 对无 detour 的既有格式行为不变（detour 不指向本批 → 原样）', () => {
    const node = (uuid: string, extra: Partial<ServerConfig> = {}): ServerConfig =>
      ({
        id: `new-${uuid}`,
        name: uuid,
        protocol: 'vless',
        address: `${uuid}.com`,
        port: 443,
        uuid,
        ...extra,
      }) as ServerConfig;
    const old = [{ ...node('a'), id: 'old-a' }];
    const r = SubscriptionService.reconcileServers(
      old,
      [node('a'), node('b', { detour: 'self-built-id' })],
      'T'
    );
    expect(r.servers.map((s) => s.id)).toEqual(['old-a', 'new-b']);
    expect(r.servers[1].detour).toBe('self-built-id');
    expect(r.contentChanged).toBe(true);
  });
});

describe('既有格式探测不变（不误判为 Xray）', () => {
  it('sing-box JSON（type，含 multiplex.protocol 嵌套键）→ sing-box 分支', async () => {
    const log = new FakeLog();
    serve({
      outbounds: [
        {
          type: 'vless',
          tag: 'sb',
          server: 'a.com',
          server_port: 443,
          uuid: 'u',
          multiplex: { enabled: true, protocol: 'h2mux' },
        },
        { type: 'direct', tag: 'direct' },
      ],
    });
    const r = await newService(log).fetchSubscription(URL, SUB_ID);
    expect(r.servers.map((s) => [s.name, s.protocol])).toEqual([['sb', 'vless']]);
    expect(log.text('info')).toMatch(/检测到 sing-box JSON 格式/);
    expect(log.text('info')).not.toMatch(/Xray/);
  });

  it('sing-box JSON 0 节点仍报 sing-box 文案（未被 Xray 分支截走）', async () => {
    serve({ outbounds: [{ type: 'direct', tag: 'd' }] });
    await expect(newService(new FakeLog()).fetchSubscription(URL, SUB_ID)).rejects.toThrow(
      /sing-box 订阅解析得到 0/
    );
  });

  it('JSON 编码 Clash / Clash YAML → Clash 分支', async () => {
    const log = new FakeLog();
    serve({ proxies: [{ name: 'c', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'u' }] });
    const r = await newService(log).fetchSubscription(URL, SUB_ID);
    expect(r.servers.map((s) => s.name)).toEqual(['c']);
    expect(log.text('info')).toMatch(/JSON 编码的 Clash/);

    const log2 = new FakeLog();
    serve(
      ['proxies:', '  - {name: y, type: trojan, server: 1.2.3.4, port: 443, password: p}'].join(
        '\n'
      )
    );
    const r2 = await newService(log2).fetchSubscription(URL, SUB_ID);
    expect(r2.servers.map((s) => s.name)).toEqual(['y']);
    expect(log2.text('info')).toMatch(/Clash YAML/);
    expect(log.text('info') + log2.text('info')).not.toMatch(/Xray/);
  });

  it('Base64 分享链接 → URL-list 分支', async () => {
    const log = new FakeLog();
    serve(Buffer.from('vless://uuid-1@a.com:443?encryption=none#b64\n').toString('base64'));
    const r = await newService(log).fetchSubscription(URL, SUB_ID);
    expect(r.servers.map((s) => s.name)).toEqual(['b64']);
    expect(log.text('info')).toMatch(/成功从订阅解析了 1 个节点/);
    expect(log.text('info')).not.toMatch(/Xray/);
  });

  it('非 Xray 的 JSON 数组（标量）→ 仍落 URL-list 分支报「无法识别」', async () => {
    serve([1, 2, 3]);
    await expect(newService(new FakeLog()).fetchSubscription(URL, SUB_ID)).rejects.toThrow(
      /无法识别订阅格式/
    );
  });
});

describe('本地导入：v2ray-json 配置数组同样可导入（此前报「无法识别文件格式」）', () => {
  it('format=xray、remarks 命名、节点归入自建', async () => {
    const r = await newService(new FakeLog()).parseLocalContent(
      JSON.stringify(v2rayJsonSubscription())
    );
    expect(r.format).toBe('xray');
    expect(r.nodes.map((s) => s.name)).toEqual(V2RAY_JSON_NODE_NAMES);
    expect(r.nodes.every((s) => s.subscriptionId === undefined)).toBe(true);
    expect(r.stats.imported).toBe(V2RAY_JSON_NODE_NAMES.length);
  });
});
