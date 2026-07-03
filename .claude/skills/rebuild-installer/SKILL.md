---
name: rebuild-installer
description: Build the Bread Chaser Windows installer (BreadChaser-windows-x64.exe) from the current tree. Use whenever asked to rebuild, build, package, or cut the installer/exe, produce a new release build, or "ship a new version" — and after finishing feature work when an installer is the natural next step. The pipeline has non-obvious failure modes (a vite resolver-cache poisoning that silently ships broken platform modules, a sync-server build clobber, a better-sqlite3 ABI flip) that this skill's procedure exists to prevent; never improvise the build order.
---

# Rebuilding the Bread Chaser installer

The output is `packages/desktop-electron/dist/BreadChaser-windows-x64.exe`
(NSIS, x64 only, unsigned — SmartScreen warns; "More info → Run anyway").
Run everything from the repo root. The app being replaced can stay running
(it has its own bundled native modules), but close it if the exe build hits
file locks.

## Preconditions

1. All work committed (`[AI]` prefix rules apply — see the
   committing-actual-changes skill).
2. Version bumped in `packages/desktop-electron/package.json` (single
   source of truth; `latest.yml` and the exe metadata derive from it).
3. `yarn typecheck` green. Note: any typecheck that walks project
   references (including desktop-electron's) CLOBBERS
   `packages/sync-server/build/` — that's fine here because step 1 below
   rebuilds it, but never launch the app between a typecheck and a
   sync-server rebuild.
4. Tests green — and remember `yarn rebuild-node` first: every
   electron-builder run (and some yarn operations) flips better-sqlite3 to
   the electron ABI, which makes ALL vitest suites fail with a
   NODE_MODULE_VERSION error. Known pre-existing failures on this machine
   (not regressions): `main.test.ts` budget-load (Windows EBUSY) and
   `plaid.test.ts` (mock missing PLAID_HISTORY_DAYS).

## The build procedure (order is load-bearing)

```bash
# 1. Web client + all workspace bundles (skip the exe here on purpose)
./bin/package-electron --skip-translations --skip-exe-build

# 2. THE CRITICAL STEP — clear the vite/rolldown resolver cache, then
#    rebuild the loot-core electron bundle STANDALONE. package-electron's
#    own sequence re-poisons #platform/server/* subpath resolution (its
#    browser build populates a shared resolver cache), which has twice
#    shipped silently broken platform modules (the local API in
#    26.6.5–26.6.7, again during the 26.8.0 build).
rm -rf node_modules/.vite packages/*/node_modules/.vite
yarn workspace @actual-app/core build:node

# 3. Grep-verify the bundle BEFORE packaging. Production builds strip
#    comments, so no-op markers are useless — only route/handler string
#    literals prove the right platform modules resolved.
B=packages/loot-core/lib-dist/electron/bundle.desktop.js
for s in "x-api-key" "paycheck-generate" "html-to-pdf-request" \
         "exclude_from_totals" "email-receipts-link-manual" \
         "plaid-replay-history" "mortgage-get-payments" "already-split"; do
  printf "%-28s %s\n" "$s" "$(grep -c "$s" "$B")"
done
# Every count must be >= 1. "x-api-key" is the canary: 0 means the cache
# poisoning struck — redo step 2.

# 4. Copy the verified bundle into the electron build tree, re-verify
cd packages/desktop-electron && yarn update-client
grep -c "x-api-key" build/loot-core/lib-dist/electron/bundle.desktop.js

# 5. Build the exe (build:dist runs plain tsgo — safe, it does NOT walk
#    references; electron-builder's beforePack rebuilds better-sqlite3 for
#    electron by downloading a prebuild, no MSVC needed)
yarn clean && yarn build:dist
yarn electron-builder --win nsis --x64 --publish never
```

## Verify the artifact

```bash
grep -m1 version dist/latest.yml          # must match package.json
A=dist/win-unpacked/resources/app.asar
grep -ac "x-api-key" "$A"                 # >= 1
# spot-check a few feature markers in the asar the same way as step 3
powershell -NoProfile -Command \
  "(Get-Item 'dist/BreadChaser-windows-x64.exe').VersionInfo.CompanyName"
# must print: Ben Yoder
```

Marker counts in the asar are higher than the bundle's (the browser-mode
loot-core worker inside the web build duplicates server strings) — that is
expected; what matters is nothing reads 0.

## Afterwards

- better-sqlite3 is now on the electron ABI. Run `yarn rebuild-node`
  before any vitest run.
- Ship: deliver the exe directly, or publish a GitHub release for
  auto-update — see the publish-github-release skill.
