/**
 * 仓库身份守卫：源码与发布脚本里不得再出现指向上游仓库（dododook/FlowZ、zhangjh/FlowZ）的 GitHub 链接。
 *
 * FlowZX 安装包内置 Xray 内核，上游安装包不含；更新源 / release 页 / 仓库与 issue 链接一旦指回上游，用户会被引去装
 * 不含 Xray 的上游包。仓库坐标统一走 shared/repo（REPO_OWNER / REPO_NAME / REPO_URL / REPO_RELEASES_URL）。
 * 扫描范围：src 下全部 .ts/.tsx（排除 __tests__，本守卫自身含被禁模式）+ scripts 下 .js/.mjs/.cjs。
 * README 等文档里对上游的致谢 / 出处链接不在范围内。
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

// github.com/<上游 owner>（含 api.github.com/repos/<owner>），以及把上游 owner 当裸字符串字面量写死（如旧 GITHUB_OWNER = 'dododook'）。
const FORBIDDEN: RegExp[] = [
  /github\.com\/(?:repos\/)?(?:dododook|zhangjh)\b/i,
  /['"`](?:dododook|zhangjh)['"`]/i,
];

function walk(dir: string, exts: string[], out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      walk(p, exts, out);
    } else if (exts.some((e) => ent.name.endsWith(e))) {
      out.push(p);
    }
  }
}

function scannedFiles(): string[] {
  const files: string[] = [];
  walk(path.join(ROOT, 'src'), ['.ts', '.tsx'], files);
  for (const ent of fs.readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })) {
    if (ent.isFile() && /\.(?:js|mjs|cjs)$/.test(ent.name)) {
      files.push(path.join(ROOT, 'scripts', ent.name));
    }
  }
  return files;
}

describe('仓库身份守卫：源码不得指向上游 GitHub 仓库', () => {
  const files = scannedFiles();
  const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

  it('扫描范围有效（非空跑：含更新服务 / 关于页 / 托盘 / 发布脚本）', () => {
    const names = files.map(rel);
    expect(names.length).toBeGreaterThan(100);
    expect(names).toEqual(
      expect.arrayContaining([
        'src/main/services/UpdateService.ts',
        'src/main/ipc/handlers/version-handlers.ts',
        'src/renderer/components/settings/about-settings.tsx',
        'src/main/services/TrayManager.ts',
        'src/main/services/LinuxServiceHelper.ts',
        'scripts/push-release.js',
      ])
    );
    expect(names.some((n) => n.includes('/__tests__/'))).toBe(false);
  });

  it('无 github.com/dododook、github.com/zhangjh 或上游 owner 字面量', () => {
    const hits: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN.some((re) => re.test(line)))
            hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('守卫模式本身能命中旧写法（防正则失效致空过）', () => {
    const samples = [
      "repositoryUrl: 'https://github.com/dododook/FlowZ',",
      'url: `https://api.github.com/repos/dododook/FlowZ/releases`,',
      'log(`🔗 https://github.com/zhangjh/FlowZ/actions`, colors.blue);',
      "const GITHUB_OWNER = 'dododook';",
    ];
    for (const s of samples) expect(FORBIDDEN.some((re) => re.test(s))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test("const REPO_OWNER = 'mutsuki14';"))).toBe(false);
  });
});
