/**
 * SERVER_ADD_BULK（本地导入批量添加）：每条重生成 id，批内 detour（Xray JSON 导入的 dialerProxy / proxySettings
 * 链，引用解析期 id）须随之改写为新 id——否则链悬空，运行期按「前置不存在 → 忽略」静默直连。
 * mock ipc-handler 捕获 handler；electron 依赖模块（ipc-events / WARP 队列）一并 mock，零 IO。
 */
const registered = new Map<string, (event: unknown, args: unknown) => unknown>();
jest.mock('../../ipc-handler', () => ({
  registerIpcHandler: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
    registered.set(channel, handler);
  },
}));
jest.mock('../../ipc-events', () => ({ ipcEventEmitter: { sendToAll: jest.fn() } }));
jest.mock('../../../services/WarpDeregisterQueue', () => ({
  getWarpDeregisterQueue: () => ({ enqueue: jest.fn() }),
}));
jest.mock('../../../services/WarpService', () => ({ WarpService: jest.fn() }));

import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import type { ServerConfig } from '../../../../shared/types';
import { registerServerHandlers } from '../server-handlers';
import type { ProtocolParser } from '../../../services/ProtocolParser';
import type { ConfigManager } from '../../../services/ConfigManager';

function setup(existing: ServerConfig[] = []) {
  const config = { servers: [...existing] } as { servers: ServerConfig[] };
  const configManager = {
    loadConfig: jest.fn(async () => config),
    saveConfig: jest.fn(async () => {}),
  } as unknown as ConfigManager;
  registerServerHandlers({} as ProtocolParser, configManager);
  const addBulk = registered.get(IPC_CHANNELS.SERVER_ADD_BULK)!;
  return { config, addBulk };
}

const node = (id: string, name: string, detour?: string): ServerConfig =>
  ({
    id,
    name,
    protocol: 'vless',
    address: `${name}.com`,
    port: 443,
    uuid: 'u',
    detour,
  }) as ServerConfig;

beforeEach(() => registered.clear());

describe('SERVER_ADD_BULK', () => {
  it('重生成 id，批内 detour 随之改写为前置节点的新 id', async () => {
    const { config, addBulk } = setup();
    const r = await addBulk(
      {},
      { servers: [node('p-exit', 'exit', 'p-front'), node('p-front', 'front')] }
    );
    expect(r).toEqual({ added: 2 });
    const [exit, front] = config.servers;
    expect(exit.id).not.toBe('p-exit');
    expect(front.id).not.toBe('p-front');
    expect(exit.detour).toBe(front.id);
    expect(front.detour).toBeUndefined();
  });

  it('批外 detour（指向存量节点）原样保留；批内重复 id 仍各自得到新 id', async () => {
    const { config, addBulk } = setup([node('keep-1', 'old')]);
    await addBulk({}, { servers: [node('dup', 'a', 'keep-1'), node('dup', 'b')] });
    const [, a, b] = config.servers;
    expect(a.detour).toBe('keep-1');
    expect(a.id).not.toBe(b.id);
  });
});
