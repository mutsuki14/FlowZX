import * as net from 'net';
import * as dgram from 'dgram';

/**
 * 一次性分配 count 个互不相同的 127.0.0.1 空闲端口：同时持有全部监听（保证批内不重复），收齐后统一释放。
 * exclude 内的端口（用户代理口 / clash_api 等）命中则重绑，至多 8 次。任一端口分配失败 → 整批 throw，
 * 调用方降级（不留半批端口）。
 *
 * opts.udp=true：同号 UDP 端口也须空闲（并在批内一并持有）。socks 入站（Xray `udp:true` / sing-box socks）在
 * **同一端口号**上同时监听 TCP 与 UDP——只验 TCP 会撞上被别的 UDP socket 占着的端口号，入站 bind 失败、整个
 * 内核起不来（实测：`listen udp 127.0.0.1:N: bind: address already in use`）。
 */
export async function allocateLoopbackPorts(
  count: number,
  exclude: ReadonlySet<number> = new Set(),
  opts: { udp?: boolean } = {}
): Promise<number[]> {
  const servers: net.Server[] = [];
  const udpSockets: dgram.Socket[] = [];
  const ports: number[] = [];
  try {
    for (let i = 0; i < count; i++) {
      let port = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const srv = net.createServer();
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(0, '127.0.0.1', () => resolve());
        });
        const p = (srv.address() as net.AddressInfo).port;
        let udp: dgram.Socket | null = null;
        let ok = !exclude.has(p) && !ports.includes(p);
        if (ok && opts.udp) {
          udp = await bindUdp(p);
          ok = udp !== null;
        }
        if (ok) {
          servers.push(srv);
          if (udp) udpSockets.push(udp);
          port = p;
          break;
        }
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
      if (!port) throw new Error('loopback port allocation collided');
      ports.push(port);
    }
    return ports;
  } finally {
    for (const u of udpSockets) {
      try {
        u.close();
      } catch {
        /* 已关闭 */
      }
    }
    await Promise.all(
      servers.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve())))
    );
  }
}

/** 试绑 127.0.0.1:port 的 UDP；成功返回 socket（调用方负责关闭），被占返回 null。 */
function bindUdp(port: number): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      try {
        sock.close();
      } catch {
        /* 未绑定成功 */
      }
      resolve(null);
    });
    sock.bind(port, '127.0.0.1', () => resolve(sock));
  });
}

/**
 * 127.0.0.1:port 上是否是**持有这组凭据**的 SOCKS5 服务：RFC 1928 方法协商 + RFC 1929 用户名/密码认证，
 * 认证通过即断开（不发 CONNECT）。比「TCP 连得上」严格——端口若被别的进程抢先监听，裸 TCP 照样连通（误判就绪），
 * 凭据握手则必失败。user 缺省 → 协商「无认证」（0x00）。
 */
export function probeSocks5Auth(
  port: number,
  user?: string,
  pass?: string,
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const method = user === undefined ? 0x00 : 0x02;
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    let buf = Buffer.alloc(0);
    let authSent = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.on('error', () => {}); // destroy 后的迟到错误不冒泡
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('error', () => done(false));
    sock.once('close', () => done(false));
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, method])));
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!authSent) {
        if (buf.length < 2) return;
        // 方法协商应答：VER=5，METHOD=所请求的方法（0xFF=无可接受方法）。
        if (buf[0] !== 0x05 || buf[1] !== method) return done(false);
        if (method === 0x00) return done(true);
        const u = Buffer.from(user ?? '', 'utf8');
        const p = Buffer.from(pass ?? '', 'utf8');
        if (u.length > 255 || p.length > 255) return done(false);
        buf = buf.subarray(2);
        authSent = true;
        sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      }
      // 认证应答：VER=1，STATUS=0 为通过。
      if (buf.length < 2) return;
      done(buf[0] === 0x01 && buf[1] === 0x00);
    });
  });
}
