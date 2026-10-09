#!/usr/bin/env node
/**
 * fetch-core.mjs — 按 core-manifest.json 的 bundledCoreVersion 从 SagerNet/sing-box 官方 release
 * 下载各平台 sing-box 二进制到 resources/{平台}/，供 electron-builder extraResources 随安装包打包
 * （与 libcronet/dashboard 同「现拉现打、不入库」模式）。
 * 同时按 bundledXrayVersion 从 XTLS/Xray-core 官方 release 拉 Xray sidecar（xray[.exe]，承载 XHTTP / VLESS
 * Encryption 等 Xray 独有协议组合，见 docs/XRAY.md），pin 为 xrayArchiveSha256 / xrayBinarySha256，同一套校验与落地流程。
 *
 * 用法：node scripts/fetch-core.mjs [--force]
 *
 * 为什么改 fetch（原内置入库）：每平台核 66–74MB、4 平台 ~276MB 直接进 git，每次换核 git history 再叠
 * 一份 → 仓库与 clone 持续膨胀。改现拉现打后核不入库，仓库瘦身、克隆变快（与 libcronet/dashboard 一致）。
 *
 * 完整性 pin：core-manifest.json 的 coreArchiveSha256 是「下载的压缩包(tar.gz/zip)本体」的 sha256，其值
 * == 官方 release REST API 返回的 asset digest（gh api repos/SagerNet/sing-box/releases/tags/v<版本>
 * --jq '.assets[]|{name,digest}'，一行可取，换核直接抄、不必下载解压计算）。下载后对压缩包逐字节校验，不符
 * 即失败（fail-fast：损坏 / 截断 / 投毒在解压前就拦）。
 *
 * 第二类 pin `coreBinarySha256` = 落地二进制本体的 sha256。压缩包 sha 已能确保解出物正确（解压确定性），
 * 故它不是为「防解压出错」而设，而是为了**让「已落地则跳过」可自证**：磁盘 sha 与 pin 对得上才跳过，
 * 对不上即当陈旧核重新下载。与 fetch-cronet 的 cronetLibSha256 同款分工。
 *
 * 跨平台一致：全 4 平台核一律下载（不按当前 runner 过滤）——支持在 Linux 上 electron-builder --win/--mac
 * --dir 交叉构建（部署流程依赖）；已落地且 sha 与 coreBinarySha256 相符则跳过，**换版本无需 --force**
 * （pin 变了即对不上，自动重下）；`--force` 仅用于无条件重拉。CI fresh checkout 无旧核故每次都下载+校验。
 * 解压：tar.gz→tar、zip→unzip（与 fetch-dashboard 同，CI 全平台已证可用）。各平台
 * 核仍是 SagerNet 官方 release（README §换核），cronet 集成因平台而异（mac-arm64 静态编入 / mac-x64 无 cronet
 * / linux+win dlopen 外部 libcronet 走 fetch:cronet），本脚本只取 sing-box 本体。
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 版本耦合的唯一真源：与 TS 主进程共享同一份 manifest，升级核心只需改 core-manifest.json。
const manifest = JSON.parse(readFileSync(join(ROOT, 'src/shared/core-manifest.json'), 'utf-8'));
const VERSION = manifest.bundledCoreVersion; // 资产名不带 v；release tag 带 v（如 v1.14.0-alpha.34）
const SHA = manifest.coreArchiveSha256 || {}; // 压缩包 sha == 官方 release API 的 asset digest
// 落地二进制本体 sha（可选 pin）。它让「已落地则跳过」这件事**可验证**：对得上才算数，对不上即当陈旧核
// 重新下载。缺它时退回旧的「存在即跳过」，并把「可能是旧核」明确喊出来（见 skip 分支）。
const BIN_SHA = manifest.coreBinarySha256 || {};
const REPO = 'SagerNet/sing-box';
const FORCE = process.argv.includes('--force');

// resources 目标目录 ← 官方资产名(压缩包) → 落地二进制名 → coreArchiveSha256 key。
// 官方资产解出单一顶层目录 sing-box-${VERSION}-${os}-${arch}/，内含 sing-box[.exe]（+ LICENSE；
// linux 资产另含 libcronet.so，本脚本只取 sing-box，cronet 仍由 fetch:cronet 按独立版本管理）。
const TARGETS = [
  {
    dir: 'resources/linux',
    asset: `sing-box-${VERSION}-linux-amd64.tar.gz`,
    bin: 'sing-box',
    key: 'linux',
  },
  {
    dir: 'resources/win',
    asset: `sing-box-${VERSION}-windows-amd64.zip`,
    bin: 'sing-box.exe',
    key: 'win',
  },
  {
    dir: 'resources/mac-x64',
    asset: `sing-box-${VERSION}-darwin-amd64.tar.gz`,
    bin: 'sing-box',
    key: 'mac-x64',
  },
  {
    dir: 'resources/mac-arm64',
    asset: `sing-box-${VERSION}-darwin-arm64.tar.gz`,
    bin: 'sing-box',
    key: 'mac-arm64',
  },
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * 拉取一组目标（sing-box 与 Xray 共用同一套「压缩包 sha → 解压 → 二进制 sha → 原子落地 / 可自证 skip」流程）。
 * src = { repo, version, tag, sha, binSha }；返回 { ok, failed, unverified }。
 */
function fetchTargets(targets, src) {
let ok = 0;
let failed = 0;
let unverified = 0; // 跳过但无 pin 可验：算 ready 但不该混进「已确认是这个版本」
const VERSION = src.version;
const SHA = src.sha;
const BIN_SHA = src.binSha;
for (const t of targets) {
  const absDir = join(ROOT, t.dir);
  const dest = join(absDir, t.bin);

  // 已落地时的处置。**跳过必须可验证**：拿磁盘上的二进制算 sha 比对 coreBinarySha256——
  //   · 对得上 → skip (verified)，此时「ready (version X)」才是真话；
  //   · 对不上 → 视作陈旧/被替换，落到下面重新下载（换 bundledCoreVersion 后**无需再记得加 --force**）；
  //   · 无 pin  → 退回「存在即跳过」，但必须把「可能是旧核」喊出来，不能让汇总行替它撒谎。
  // 为什么非做不可（2026-08-05 实测踩坑）：旧实现无条件 skip，而汇总行照打 manifest 版本，于是
  // 「4 ready (version 1.14.0-beta.7)」在磁盘还是 beta.5 时依然打印——据此跑的真核 check 把新字段
  // 误判成 unknown field。绿/ready 必须有信息量，否则比没有更坏。
  const wantBin = (BIN_SHA[t.key] || '').replace(/^sha256:/, '');
  if (existsSync(dest) && !FORCE) {
    if (wantBin) {
      const gotBin = sha256(dest);
      if (gotBin === wantBin) {
        console.log(`skip (verified): ${t.dir}/${t.bin} (bin sha ${gotBin.slice(0, 12)}…)`);
        ok++;
        continue;
      }
      console.log(
        `stale: ${t.dir}/${t.bin} 与 coreBinarySha256 不符（磁盘 ${gotBin.slice(0, 12)}… ≠ pin ${wantBin.slice(0, 12)}…）→ 重新下载`
      );
    } else {
      console.log(
        `skip (unverified): ${t.dir}/${t.bin} — core-manifest.json 缺 coreBinarySha256[${t.key}]，无法确认磁盘上是否就是 ${VERSION}；若刚改 bundledCoreVersion 须加 --force`
      );
      ok++;
      unverified++;
      continue;
    }
  }

  // 完整性 pin 是供应链防护核心：缺 pin 直接 fail（绝不无校验拉可执行核），强制换版本时同步补 coreArchiveSha256。
  // normalize：容忍值带/不带 `sha256:` 前缀——官方 release REST API 的 asset digest 形如 `sha256:<hex>`，可原样抄进 manifest。
  const want = (SHA[t.key] || '').replace(/^sha256:/, '');
  if (!want) {
    console.error(
      `  FAILED ${t.key}: core-manifest.json 缺 ${src.shaKey}[${t.key}] pin → 拒绝无完整性校验拉取（换版本须同步补；值=官方 release API 的 asset digest）`
    );
    failed++;
    continue;
  }

  mkdirSync(absDir, { recursive: true });
  const url = `https://github.com/${src.repo}/releases/download/${src.tag}/${t.asset}`;
  const work = mkdtempSync(join(tmpdir(), 'flowz-core-'));
  try {
    const archive = join(work, t.asset);
    console.log(`downloading ${t.asset} ...`);
    // -fL：失败返回非零（不把 404 页面当成功）+ 跟随重定向(release → objects.githubusercontent)；--retry 抗瞬时抖动。
    execFileSync('curl', ['-fL', '--retry', '3', '-o', archive, url], { stdio: 'inherit' });

    // 完整性校验：对下载的压缩包本体算 sha256，比对 manifest pin（= 官方 API asset digest）。fail-fast 于解压前。
    const got = sha256(archive);
    if (got !== want) {
      throw new Error(`压缩包 sha256 不符：期望 ${want}，实得 ${got}（版本漂移 / 投毒 / 截断）`);
    }

    const extractDir = join(work, 'x');
    mkdirSync(extractDir, { recursive: true });
    if (t.asset.endsWith('.zip')) {
      execFileSync('unzip', ['-q', '-o', archive, '-d', extractDir], { stdio: 'inherit' });
    } else {
      execFileSync('tar', ['xzf', archive, '-C', extractDir], { stdio: 'inherit' });
    }

    // 找含目标二进制的目录（官方为单一顶层目录；容错平铺）。
    let binPath = null;
    for (const n of readdirSync(extractDir)) {
      const cand = join(extractDir, n, t.bin);
      if (existsSync(cand)) {
        binPath = cand;
        break;
      }
    }
    if (!binPath && existsSync(join(extractDir, t.bin))) binPath = join(extractDir, t.bin);
    if (!binPath) throw new Error(`解压产物未找到 ${t.bin}（官方资产结构可能变化）`);

    // 原子落地：拷到 .tmp → chmod（unix 可执行）→ rename 顶替（避免半写文件被打包/误用）。
    const tmpDest = `${dest}.tmp`;
    rmSync(tmpDest, { force: true });
    copyFileSync(binPath, tmpDest);
    if (!t.bin.endsWith('.exe')) chmodSync(tmpDest, 0o755);

    // 完整性校验②：落地二进制本体 sha。压缩包 sha 已确保来源可信，本条锁的是「从包里取出来的到底是哪个
    // 文件」，并为下次运行的 verified-skip 留下可自证的锚（与 fetch-cronet 的 cronetLibSha256 同款分工）。
    // 无 pin 时打印实得值，供换版本时抄进 manifest（同 fetch-cronet 的用法）。
    const gotBin = sha256(tmpDest);
    if (wantBin && gotBin !== wantBin) {
      rmSync(tmpDest, { force: true });
      throw new Error(
        `二进制 sha256 不符：期望 ${wantBin}，实得 ${gotBin}（官方资产内容变化 / 取错文件）`
      );
    }
    renameSync(tmpDest, dest);
    console.log(
      `  ok: ${t.dir}/${t.bin} (archive sha ${got.slice(0, 12)}…, bin sha ${gotBin}${wantBin ? '' : ' ← 请抄进 coreBinarySha256'})`
    );
    ok++;
  } catch (e) {
    console.error(`  FAILED ${t.key}: ${e.message}`);
    failed++;
  } finally {
    rmSync(work, { recursive: true, force: true });
    // 同清目标目录的半成品：copyFileSync/chmodSync 中途失败会把 `<bin>.tmp` 留在 resources/<平台>/，
    // 而 electron-builder 的 extraResources 是 filter `**/*` —— 失败后若跳过 fetch 直接打包，残留会被
    // 原样打进安装包。下次成功运行虽会自愈，但那要等到「下次」，中间窗口足以产出脏包。
    rmSync(`${dest}.tmp`, { force: true });
  }
}
return { ok, failed, unverified };
}

// 汇总行只在**全部可验证**时才敢把版本号说死；有 unverified 项就把话说回去——这行正是当初骗人的那行。
const summarize = (label, r, version, pinKey) =>
  console.log(
    `\n${label}: ${r.ok} ready, ${r.failed} failed` +
      (r.unverified > 0
        ? ` — 其中 ${r.unverified} 个未经校验，磁盘上未必是 ${version}（补 ${pinKey} 或加 --force）`
        : ` (version ${version}).`)
  );

const sb = fetchTargets(TARGETS, {
  repo: REPO,
  version: VERSION,
  tag: `v${VERSION}`,
  sha: SHA,
  binSha: BIN_SHA,
  shaKey: 'coreArchiveSha256',
  binShaKey: 'coreBinarySha256',
});
summarize('sing-box cores', sb, VERSION, 'coreBinarySha256');

// ── Xray 内核（sidecar，承载 XHTTP / VLESS Encryption 等 Xray 独有协议组合，见 docs/XRAY.md）──
// XTLS 官方 release：zip 平铺（xray[.exe] 在包根，另含 geoip/geosite/LICENSE，本脚本只取 xray 本体——
// FlowZ 的 Xray 配置不引用 geo 文件）。archive sha == release 附带的 `<asset>.dgst` 中 SHA2-256。
const XRAY_VERSION = manifest.bundledXrayVersion;
const XRAY_TARGETS = [
  { dir: 'resources/linux', asset: 'Xray-linux-64.zip', bin: 'xray', key: 'linux' },
  { dir: 'resources/win', asset: 'Xray-windows-64.zip', bin: 'xray.exe', key: 'win' },
  { dir: 'resources/mac-x64', asset: 'Xray-macos-64.zip', bin: 'xray', key: 'mac-x64' },
  { dir: 'resources/mac-arm64', asset: 'Xray-macos-arm64-v8a.zip', bin: 'xray', key: 'mac-arm64' },
];
let xr = { ok: 0, failed: 0, unverified: 0 };
if (XRAY_VERSION) {
  xr = fetchTargets(XRAY_TARGETS, {
    repo: 'XTLS/Xray-core',
    version: XRAY_VERSION,
    tag: `v${XRAY_VERSION}`,
    sha: manifest.xrayArchiveSha256 || {},
    binSha: manifest.xrayBinarySha256 || {},
    shaKey: 'xrayArchiveSha256',
    binShaKey: 'xrayBinarySha256',
  });
  summarize('xray cores', xr, XRAY_VERSION, 'xrayBinarySha256');
} else {
  console.log('\nxray cores: core-manifest.json 未声明 bundledXrayVersion，跳过');
}
process.exit(sb.failed + xr.failed > 0 ? 1 : 0);
