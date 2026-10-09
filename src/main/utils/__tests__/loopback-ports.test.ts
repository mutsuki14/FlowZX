/**
 * probeSocks5Auth：Xray sidecar 就绪判据（RFC 1928 方法协商 + RFC 1929 用户名/密码认证）。
 * 纯 Node 本地服务器模拟各类监听者，零外部二进制（CI 三平台可跑）。
 */
import * as net from 'net';
import { probeSocks5Auth } from '../loopback-ports';

type Handler = (sock: net.Socket) => void;

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

async function listen(handler: Handler): Promise<number> {
  const srv = net.createServer((sock) => {
    sockets.push(sock);
    sock.on('error', () => {});
    handler(sock);
  });
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  return (srv.address() as net.AddressInfo).port;
}

/** 最小 SOCKS5 服务端：只支持 user/pass（或 noAuth=true 时只支持无认证），校验固定账号。 */
function socks5(opts: {
  user?: string;
  pass?: string;
  noAuth?: boolean;
  split?: boolean;
}): Handler {
  return (sock) => {
    let buf = Buffer.alloc(0);
    let stage: 'method' | 'auth' = 'method';
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'method') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        const want = opts.noAuth ? 0x00 : 0x02;
        if (!methods.includes(want)) {
          sock.end(Buffer.from([0x05, 0xff]));
          return;
        }
        if (opts.split) {
          // 应答拆成两段发：客户端须能拼包
          sock.write(Buffer.from([0x05]));
          setTimeout(() => sock.write(Buffer.from([want])), 20);
        } else {
          sock.write(Buffer.from([0x05, want]));
        }
        stage = 'auth';
        return;
      }
      if (buf.length < 2) return;
      const ulen = buf[1];
      if (buf.length < 3 + ulen) return;
      const plen = buf[2 + ulen];
      if (buf.length < 3 + ulen + plen) return;
      const user = buf.subarray(2, 2 + ulen).toString();
      const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
      const ok = user === opts.user && pass === opts.pass;
      sock.end(Buffer.from([0x01, ok ? 0x00 : 0x01]));
    });
  };
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map((srv) => new Promise<void>((resolve) => srv.close(() => resolve())))
  );
});

describe('probeSocks5Auth', () => {
  it('持有该凭据的 SOCKS5 服务 → true', async () => {
    const port = await listen(socks5({ user: 'flowz', pass: 's3cret' }));
    await expect(probeSocks5Auth(port, 'flowz', 's3cret')).resolves.toBe(true);
  });

  it('应答分段到达也能拼包判定', async () => {
    const port = await listen(socks5({ user: 'flowz', pass: 's3cret', split: true }));
    await expect(probeSocks5Auth(port, 'flowz', 's3cret')).resolves.toBe(true);
  });

  it('凭据不符（别的 SOCKS5 服务占了端口）→ false', async () => {
    const port = await listen(socks5({ user: 'other', pass: 'x' }));
    await expect(probeSocks5Auth(port, 'flowz', 's3cret')).resolves.toBe(false);
  });

  it('不接受用户名/密码方法 → false', async () => {
    const port = await listen(socks5({ noAuth: true }));
    await expect(probeSocks5Auth(port, 'flowz', 's3cret')).resolves.toBe(false);
  });

  it('无账号时协商无认证方法', async () => {
    const port = await listen(socks5({ noAuth: true }));
    await expect(probeSocks5Auth(port)).resolves.toBe(true);
  });

  it('非 SOCKS 监听者（TCP 连得上但回 HTTP）→ false', async () => {
    const port = await listen((sock) => sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await expect(probeSocks5Auth(port, 'flowz', 's3cret')).resolves.toBe(false);
  });

  it('只接受连接、从不应答 → 超时 false', async () => {
    const port = await listen(() => {});
    const t0 = Date.now();
    await expect(probeSocks5Auth(port, 'flowz', 's3cret', 200)).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('无人监听 → false', async () => {
    const port = await listen(() => {});
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(probeSocks5Auth(port, 'flowz', 's3cret')).resolves.toBe(false);
  });
});
