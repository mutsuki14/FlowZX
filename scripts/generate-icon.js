/**
 * 由 build/logo/*.svg（矢量母版）重新生成全部随包图标：
 *
 *   tile.svg        macOS Big Sur 网格（1024 画布上 824 圆角方块 + 投影）
 *                   → build/icon.icns、build/icon.ico 与 build/icons 的 ≥64px 帧、build/icon.png、docs/logo.png、
 *                     src/renderer/assets/flowz-icon.svg（关于页：裁到 824 方块本体、去外投影）
 *   tile-small.svg  满版、扁平、标记更大 → build/icon.ico 与 build/icons 的 16/24/32/48px 帧
 *   glyph.svg       仅标记（已连接，彩色）→ resources/app.png（窗口图标 / 托盘兜底）、tray-mac-connected(.png/@2x)、
 *                   tray-win-connected.ico
 *   glyph-gray.svg  仅标记（未连接，灰色）→ resources/app-gray.png、tray-mac-idle(.png/@2x)、tray-win-idle.ico
 *   banner.svg      README 横幅（GitHub 浅色主题）→ docs/banner.png
 *   banner-dark.svg README 横幅（GitHub 深色主题）→ docs/banner-dark.png
 *                   横幅文字只写 font-family，渲染时注入渲染端同一套品牌字体（src/renderer/assets/fonts）。
 *
 * 每个尺寸都由 Chromium 按目标像素直接栅格化矢量（不从 1024 缩小，小尺寸不糊）。ICO 中 <256 的帧写 32 位 BMP、
 * 256 帧写 PNG（Windows 图标惯例，兼容 NSIS / rcedit）；ICNS 帧全为 PNG（icp4…ic14，与旧 icon.icns 同一组 chunk）。
 *
 * 运行（不新增依赖，用项目自带的 Electron）：
 *   npx electron scripts/generate-icon.js
 *   Linux 无桌面 / root：xvfb-run -a npx electron scripts/generate-icon.js --no-sandbox
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'build', 'logo');

const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SMALL_SIZES = new Set([16, 24, 32, 48]); // 用 tile-small.svg 的帧
const APP_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_MAC_SIZES = [18, 36]; // 菜单栏 18pt + @2x（glyph 几何按这两个尺寸对齐像素）
const TRAY_WIN_SIZES = [16, 20, 24, 32, 40, 48]; // SM_CXSMICON @ 100/125/150/200/250/300% DPI
// [chunk 类型, 像素尺寸]：1x 16/32/64/128/256/512/1024 + @2x 32/64/256/512
const ICNS_CHUNKS = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration(); // 软件光栅化：输出与 GPU 无关、可复现

/**
 * 在页面内执行：把 SVG 画到 width×height 的 canvas，返回 PNG（及可选的 RGBA 原始像素）的 base64。
 * settleMs：onload 后再等片刻才绘制。banner 内嵌 data: 字体，实测 onload 时已就绪，留余量防止个别环境回退到系统字体。
 */
function renderInPage(src, width, height, wantPixels, settleMs) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      setTimeout(() => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const png = canvas.toDataURL('image/png').split(',')[1];
        let rgba = null;
        if (wantPixels) {
          const data = ctx.getImageData(0, 0, width, height).data;
          let bin = '';
          for (let i = 0; i < data.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
          }
          rgba = btoa(bin);
        }
        resolve({ png, rgba });
      }, settleMs);
    img.onerror = () => reject(new Error('SVG decode failed'));
    img.src = src;
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Chromium 的 PNG 编码只做快速压缩：把 IDAT 解压后以 zlib 9 级重压（像素不变，体积约减 60%）。 */
function optimizePng(png) {
  const keep = [];
  const idat = [];
  for (let i = 8; i < png.length; ) {
    const len = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + len));
    else if (type !== 'IEND') keep.push(png.subarray(i, i + 12 + len));
    i += 12 + len;
  }
  const data = zlib.deflateSync(zlib.inflateSync(Buffer.concat(idat)), { level: 9, memLevel: 9 });
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  return Buffer.concat([
    png.subarray(0, 8),
    ...keep,
    chunk('IDAT', data),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function createRasterizer(win) {
  const cache = new Map();
  return async function rasterize(svgFile, size, wantPixels = false) {
    const key = `${svgFile}@${size}`;
    const hit = cache.get(key);
    if (hit && (hit.rgba || !wantPixels)) return hit;
    const text = fs.readFileSync(path.join(LOGO, svgFile), 'utf8');
    // 根 <svg> 的 width/height 改成目标尺寸（viewBox 不变）→ 浏览器按目标像素栅格化矢量。
    const sized = text.replace(/<svg\b[^>]*>/, (tag) =>
      tag
        .replace(/\swidth="[^"]*"/, ` width="${size}"`)
        .replace(/\sheight="[^"]*"/, ` height="${size}"`)
    );
    const src = `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`;
    const res = await win.webContents.executeJavaScript(
      `(${renderInPage.toString()})(${JSON.stringify(src)}, ${size}, ${size}, ${wantPixels}, 0)`
    );
    const out = {
      size,
      png: optimizePng(Buffer.from(res.png, 'base64')),
      rgba: res.rgba ? Buffer.from(res.rgba, 'base64') : null,
    };
    cache.set(key, out);
    return out;
  };
}

/** ICO 内 32 位 BMP 帧：BITMAPINFOHEADER（高度 ×2 含 AND 掩码）+ 自底向上 BGRA + AND 掩码（alpha=0 处置 1，供只认掩码的绘制路径）。 */
function bmpFrame(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const row = size - 1 - y;
      const d = (row * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  const blobs = [];
  let offset = header.length + dir.length;
  frames.forEach((f, i) => {
    const data = f.size >= 256 ? f.png : bmpFrame(f.size, f.rgba);
    const e = i * 16;
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e); // 0 表示 256
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e + 1);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
    blobs.push(data);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

function buildIcns(pngBySize) {
  const chunks = ICNS_CHUNKS.map(([type, size]) => {
    const png = pngBySize.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** 关于页 SVG：tile.svg 裁到 824 方块本体（满版），去掉方块外投影。 */
function aboutPageSvg() {
  let svg = fs.readFileSync(path.join(LOGO, 'tile.svg'), 'utf8');
  svg = svg.replace(
    /<svg\b[^>]*>/,
    '<svg xmlns="http://www.w3.org/2000/svg" width="824" height="824" viewBox="100 100 824 824">'
  );
  svg = svg.replace(/\s*<filter id="tileShadow"[\s\S]*?<\/filter>/, '');
  svg = svg.replace(' filter="url(#tileShadow)"', '');
  svg = svg.replace(
    /<!-- FlowZX app icon \(macOS Big Sur grid: 824 tile on a 1024 canvas\)\./,
    '<!-- FlowZX app icon: full-bleed crop of build/logo/tile.svg (renderer About page; generated by scripts/generate-icon.js).'
  );
  if (svg.includes('tileShadow') || !svg.includes('viewBox="100 100 824 824"')) {
    throw new Error('tile.svg structure changed: update aboutPageSvg()');
  }
  return svg;
}

// 横幅可用的品牌字体：渲染时以 data: @font-face 注入 SVG（SVG 图像不能加载外部字体文件）。
const FONT_DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'fonts');
const BANNER_FONTS = [
  ['Space Grotesk', 600, 'space-grotesk-latin-600-normal.woff2'],
  ['Space Grotesk', 700, 'space-grotesk-latin-700-normal.woff2'],
  ['IBM Plex Sans', 400, 'ibm-plex-sans-latin-400-normal.woff2'],
  ['IBM Plex Sans', 500, 'ibm-plex-sans-latin-500-normal.woff2'],
  ['IBM Plex Sans', 600, 'ibm-plex-sans-latin-600-normal.woff2'],
  ['IBM Plex Mono', 400, 'ibm-plex-mono-latin-400-normal.woff2'],
  ['IBM Plex Mono', 500, 'ibm-plex-mono-latin-500-normal.woff2'],
];

function withBrandFonts(svg) {
  const faces = BANNER_FONTS.map(([family, weight, file]) => {
    const data = fs.readFileSync(path.join(FONT_DIR, file)).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${data}) format('woff2');}`;
  }).join('');
  return svg.replace(/<svg\b[^>]*>/, (tag) => `${tag}<style>${faces}</style>`);
}

/** README 横幅：按母版自身的 width×height 栅格化（onload 后留 600ms 余量再绘制）。 */
async function renderBanner(win, svgFile) {
  const svg = withBrandFonts(fs.readFileSync(path.join(LOGO, svgFile), 'utf8'));
  const root = /<svg\b[^>]*>/.exec(svg)[0];
  const width = Number(/\swidth="(\d+)"/.exec(root)[1]);
  const height = Number(/\sheight="(\d+)"/.exec(root)[1]);
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const res = await win.webContents.executeJavaScript(
    `(${renderInPage.toString()})(${JSON.stringify(src)}, ${width}, ${height}, false, 600)`
  );
  return optimizePng(Buffer.from(res.png, 'base64'));
}

function write(rel, data) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`  ${rel}  (${data.length} bytes)`);
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  const rasterize = createRasterizer(win);
  const appFrame = (size, px) =>
    rasterize(SMALL_SIZES.has(size) ? 'tile-small.svg' : 'tile.svg', size, px);

  console.log('Generating icons from build/logo/*.svg');
  for (const size of LINUX_SIZES) {
    write(`build/icons/${size}x${size}.png`, (await appFrame(size)).png);
  }
  write('build/icon.png', (await appFrame(1024)).png);
  write('docs/logo.png', (await appFrame(256)).png);

  const icoFrames = [];
  for (const size of APP_ICO_SIZES) icoFrames.push(await appFrame(size, size < 256));
  write('build/icon.ico', buildIco(icoFrames));

  const macPng = new Map();
  for (const [, size] of ICNS_CHUNKS) macPng.set(size, (await rasterize('tile.svg', size)).png);
  write('build/icon.icns', buildIcns(macPng));

  for (const [state, svgFile, appPng] of [
    ['connected', 'glyph.svg', 'app.png'],
    ['idle', 'glyph-gray.svg', 'app-gray.png'],
  ]) {
    write(`resources/${appPng}`, (await rasterize(svgFile, 1024)).png);
    const [x1, x2] = TRAY_MAC_SIZES;
    write(`resources/tray-mac-${state}.png`, (await rasterize(svgFile, x1)).png);
    write(`resources/tray-mac-${state}@2x.png`, (await rasterize(svgFile, x2)).png);
    const trayFrames = [];
    for (const size of TRAY_WIN_SIZES) trayFrames.push(await rasterize(svgFile, size, true));
    write(`resources/tray-win-${state}.ico`, buildIco(trayFrames));
  }

  write('src/renderer/assets/flowz-icon.svg', aboutPageSvg());
  write('docs/banner.png', await renderBanner(win, 'banner.svg'));
  write('docs/banner-dark.png', await renderBanner(win, 'banner-dark.svg'));
  win.destroy();
}

app
  .whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((err) => {
    console.error('✗ Icon generation failed:', err);
    app.exit(1);
  });
