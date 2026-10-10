# Release Guide

[简体中文](RELEASE.md) · **English**

This document describes how to release a new version of FlowZX. Releases are made by the GitHub Actions Release workflow (`.github/workflows/release.yml`): push a `v*` tag, or run the workflow manually on `main`. It packages the app on three platforms and publishes the GitHub Release directly. Local packaging is for verification only and never publishes anything.

## Prerequisites

- **GitHub Actions enabled**: it is enabled for this repository; if it is disabled under Settings → Actions → General, no workflow runs. Release creates the tag and the Release with the built-in `GITHUB_TOKEN` (the workflow declares `contents: write`); no secrets need to be configured.
- **Push access**: to push to `main` and push tags.
- **Node.js 26**: the same version as CI.
- **Go 1.24 or later**: used to compile the privileged helper when packaging locally; without it the step is skipped and the package has no privileged helper. Go is available in CI.

## Workflows

| Workflow | Triggers | What it does |
|---|---|---|
| CI (`ci.yml`) | Pushes to `main`, PRs to `main`, manual runs | Lint, unit tests and build on macOS and Windows |
| Package (`package.yml`) | Same as CI, but pushes and PRs only trigger it when they touch packaging inputs (`package.json`, `package-lock.json`, `electron-builder.json`, `scripts/`, `helper*/`, `build/`, `resources/`, `src/shared/core-manifest.json`, `.github/workflows/`) | PRs: `electron-builder --dir` smoke test; pushes / manual runs: full Windows and macOS packaging, uploading the Windows installers (kept for 3 days) |
| Release (`release.yml`) | Pushing a `v*` tag; a manual run on `main` | Packages on Windows / macOS / Linux and publishes the GitHub Release |

## Release steps

1. **Bump the version**. This command updates both `package.json` and `package-lock.json` without creating a commit or a tag:

   ```bash
   npm version patch --no-git-tag-version   # or minor / major / an explicit version
   ```

2. **Write the release notes** in `docs/releases/v<version>.md`, following the existing files (Chinese first, then English). The Release body is taken from this file, followed by GitHub's auto-generated Release Notes; without the file, only the auto-generated part is used.

3. **Commit and push to `main`**, and make sure CI passes (Package also runs when packaging inputs changed).

4. **Trigger the Release**, either way:
   - **Push a tag**: run `npm run release:tag` on `main`. `scripts/push-release.js` reads the version from `package.json`, creates the annotated tag `v<version>` and pushes it to `origin`. `npm run release:tag -- -y` skips the confirmation; `npm run release:tag -- -u` deletes and re-pushes an existing tag of the same name; `npm run release:tag:update` is the same as `-- -y -u`. The tag must match the `package.json` version: on a mismatch the workflow only warns, and the installer file names still follow `package.json`; the installed app then reports the `package.json` version while the in-app updater compares against the tag, so it keeps offering the same "update".
   - **Run it manually**: on the Actions page, select Release → **Run workflow** with the `main` branch (or trigger `workflow_dispatch` via the API). The version comes from `package.json`; after the builds finish, the workflow creates the tag `v<version>` on that commit and publishes the release. This tag does not trigger Release again. If the tag already exists and points to a different commit, the workflow fails and you need to bump the version first; if it points to the same commit, the run is treated as a re-run.

5. **Check the Release**: the Releases page should show `Release <version>` (not a draft, not a prerelease) with six installers:

   | Platform | Files |
   |---|---|
   | Windows x64 | `FlowZ-<version>-win-x64-setup.exe`, `FlowZ-<version>-win-x64-portable.exe` |
   | macOS | `FlowZ-<version>-mac-arm64.dmg`, `FlowZ-<version>-mac-x64.dmg` |
   | Linux x86_64 | `FlowZ-<version>-linux-x86_64.AppImage`, `FlowZ-<version>-linux-amd64.deb` |

   The in-app **Check for Updates** reads this repository's most recently published non-prerelease Release, takes the version from its tag, and picks the installer for the current platform and install type by file name, so don't change the installer names.

## What the Release workflow does

- **meta**: resolves the version. On a tag push it uses the tag name; on a manual run it uses `package.json` and checks that the branch is `main` and that no tag of the same name points to a different commit.
- **release**: runs `npm ci`, `npm run build` and `npm run package:<platform>` in parallel on `windows-2022`, `macos-14` and `ubuntu-latest`. `REQUIRE_HELPER=1` is set, so a missing Go toolchain fails the build instead of publishing packages without the privileged helper. On macOS it then ad-hoc signs the arm64 and x64 `FlowZ.app` bundles and packs each into a DMG with `hdiutil` (including a first-launch guide); a missing architecture fails the job.
- **create-release**: publishes the `v<version>` Release with `softprops/action-gh-release` and uploads all installers.

## Local packaging (verification only, no release)

```bash
npm run dist:win     # Windows installer + portable (x64)
npm run dist:mac     # macOS arm64 + x64 FlowZ.app (DMGs are only built in CI)
npm run dist:linux   # Linux AppImage + deb (x64)
```

`dist:*` passes `--publish never`; output goes to `dist-package/`. Package each platform on that platform. Before packaging, the scripts run `build:helper`, `fetch:core`, `test:core-gate`, `fetch:cronet` (Windows / Linux only), `fetch:dashboard` and `build` in that order.

sing-box, Xray, cronet and the dashboard are not committed; they are downloaded at build time, and the first three are verified against the SHA-256 values in `src/shared/core-manifest.json`. To change a core version, update its version and SHA-256 values in that file (sing-box: `bundledCoreVersion`, `coreArchiveSha256`, `coreBinarySha256`; Xray: `bundledXrayVersion`, `xrayArchiveSha256`, `xrayBinarySha256`), then run `npm run fetch:core` and `npm run test:core-gate`.

## Versioning

Follow [Semantic Versioning](https://semver.org/). The `version` field in `package.json` has no `v` prefix; tags look like `v4.4.1`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Release didn't run after pushing a tag | Check that the tag starts with `v` and that Actions isn't disabled for the repository, then run Release manually on `main` (a tag that points to the current commit is treated as a re-run), or re-push the tag with `npm run release:tag -- -u` |
| Manual run fails: only allowed on `main` | Select the `main` branch when running it |
| Manual run fails: the tag already exists and points to a different commit | Bump the version in `package.json` and release again |
| `release:tag` reports that the remote tag already exists | Bump the version and release again. `-u` deletes and re-pushes the tag; only use it for a version that hasn't been released yet |
| A macOS architecture's DMG is missing from the Release | The **Create DMG** step fails with an error; check that `package:mac` produced both the arm64 and x64 `FlowZ.app` |
| "Helper binary missing" when installing | Go was missing when packaging; install Go and package again |
| Build fails | Reinstall dependencies with `npm ci`; make sure GitHub and `proxy.golang.org` are reachable (`fetch:*` needs network access); check the CI logs for the failing platform |
