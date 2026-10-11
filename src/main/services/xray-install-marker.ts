/**
 * Xray 现役槽位 `<userData>/xray_core/xray[.exe]` 的来源判定 + 在线安装标记文件（flowzx-xray.json）。
 *
 * 槽位沿用既有「手动放入覆盖核」机制（ResourceManager.getXrayPath：存在且可执行即优先于随包核），在线安装也写这里，
 * 二者靠标记文件区分：
 *  - bundled    ：槽位无（可用）二进制 → 跑随包核；
 *  - downloaded ：槽位二进制 sha256 == 标记里的 binarySha256（应用内安装后未被替换）；
 *  - custom     ：槽位有二进制但无标记 / 哈希对不上（用户自行放入或覆盖了文件）。
 * 哈希按 path+size+mtime 缓存（xray ~40MB，状态页/诊断会反复查询）。
 *
 * ProxyManager.getXrayStatus（状态 IPC / 诊断）与 XrayCoreUpdateService（安装/恢复）共用，故独立成模块、不依赖二者。
 */
import { createHash } from 'crypto';
import { createReadStream, constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import { xrayBinaryName, type XraySourceInfo } from '../../shared/xray-release';

/** 标记文件名（与二进制同目录；文件名带 flowzx 前缀，避免与用户放入的任意文件撞名）。 */
export const XRAY_MARKER_FILE = 'flowzx-xray.json';

/** 一次应用内安装的记录（安装成功、切换落位后原子写入）。 */
export interface XrayInstallMarker {
  tag: string;
  version: string;
  prerelease: boolean;
  /** 落位二进制的 sha256（macOS 为 ad-hoc 重签之后的值）。 */
  binarySha256: string;
  /** 下载的 zip 本体 sha256（= API digest / .dgst）。 */
  archiveSha256: string;
  assetName: string;
  installedAt: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** 解析标记 JSON；字段缺失 / 形状不符 → null（视为无标记，槽位文件按 custom 处理，宁可多备份不误删）。 */
export function parseXrayMarker(text: string): XrayInstallMarker | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const tag = str('tag');
  const version = str('version');
  const binarySha256 = str('binarySha256');
  const archiveSha256 = str('archiveSha256');
  const assetName = str('assetName');
  const installedAt = str('installedAt');
  if (!tag || !version || !assetName || !installedAt) return null;
  if (!binarySha256 || !HEX64.test(binarySha256)) return null;
  if (!archiveSha256 || !HEX64.test(archiveSha256)) return null;
  return {
    tag,
    version,
    prerelease: r.prerelease === true,
    binarySha256,
    archiveSha256,
    assetName,
    installedAt,
  };
}

export async function readXrayMarker(dir: string): Promise<XrayInstallMarker | null> {
  try {
    return parseXrayMarker(await fs.readFile(path.join(dir, XRAY_MARKER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** 流式 sha256（不把 40MB 二进制整块读进内存）；读不到 → null。 */
export function sha256File(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// path → {size|mtime 指纹, sha}。文件被替换（size/mtime 变）即失效；只记最近一次，条目数 = 被查询的路径数（极少）。
const hashCache = new Map<string, { key: string; sha: string }>();

/** 带 path+size+mtime 缓存的 sha256（状态查询热路径用）。 */
export async function sha256FileCached(filePath: string): Promise<string | null> {
  let key: string;
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return null;
    key = `${st.size}|${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = hashCache.get(filePath);
  if (hit && hit.key === key) return hit.sha;
  const sha = await sha256File(filePath);
  if (sha) hashCache.set(filePath, { key, sha });
  return sha;
}

/** 单测用：清空哈希缓存。 */
export function clearXrayHashCache(): void {
  hashCache.clear();
}

/**
 * 判定槽位二进制的来源。「槽位是否生效」与 ResourceManager.getXrayPath 同判据（Windows 只看存在，POSIX 要可执行），
 * 否则会出现「状态说是 downloaded、实际跑的是随包核」的撕裂。永不抛错（读失败一律按保守结论）。
 */
export async function detectXraySource(
  dir: string,
  platform: string = process.platform
): Promise<XraySourceInfo> {
  const slot = path.join(dir, xrayBinaryName(platform));
  try {
    await fs.access(slot, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch {
    return { source: 'bundled' };
  }
  const marker = await readXrayMarker(dir);
  if (!marker) return { source: 'custom' };
  const sha = await sha256FileCached(slot);
  if (!sha || sha !== marker.binarySha256) return { source: 'custom' };
  return {
    source: 'downloaded',
    tag: marker.tag,
    prerelease: marker.prerelease,
    installedAt: marker.installedAt,
  };
}
