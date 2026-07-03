---
name: publish-github-release
description: Push the bread-chaser branch and publish a Bread Chaser release (exe + blockmap + latest.yml) to github.com/Jroll1125/Bread-Chaser so installed apps auto-update. Use whenever asked to publish to GitHub, push a release, ship/release a version, publish vX.Y.Z, or make auto-update pick up a new build. The repo setup is unusual (origin is the actualbudget upstream — NEVER push there; Ben's repo is a separate remote) and electron-updater needs exactly three assets, so follow this procedure rather than improvising.
---

# Publishing a Bread Chaser release to GitHub

Auto-update (electron-updater) polls the latest GitHub release of
`Jroll1125/Bread-Chaser` on app launch, downloads in the background, and
installs on quit. A release needs exactly these three assets from
`packages/desktop-electron/dist/`:

- `BreadChaser-windows-x64.exe`
- `BreadChaser-windows-x64.exe.blockmap`
- `latest.yml`

Build and verify them first — see the rebuild-installer skill.

## Repo layout facts (do not guess)

- `origin` = `https://github.com/actualbudget/actual.git` — the UPSTREAM
  project, kept for pulling. **Never push the bread-chaser branch or
  releases there.**
- Ben's repo is `https://github.com/Jroll1125/Bread-Chaser.git`, remote
  name `ben` (add it if missing:
  `git remote add ben https://github.com/Jroll1125/Bread-Chaser.git`).
- For token-free auto-update downloads the repo must be PUBLIC. If it is
  private, installed apps cannot download updates.

## Procedure

```bash
# 0. Auth (one-time per machine). If this fails, Ben must run
#    `gh auth login` (browser flow) himself — never handle his
#    credentials directly.
gh auth status

# 1. Push the branch to Ben's repo (NOT origin)
git push ben bread-chaser

# 2. Create the release with all three assets. VERSION comes from
#    packages/desktop-electron/package.json and must match latest.yml.
cd packages/desktop-electron
VERSION=$(node -p "require('./package.json').version")
grep -m1 "version: $VERSION" dist/latest.yml   # sanity: must match
gh release create "v$VERSION" \
  dist/BreadChaser-windows-x64.exe \
  dist/BreadChaser-windows-x64.exe.blockmap \
  dist/latest.yml \
  --repo Jroll1125/Bread-Chaser \
  --title "Bread Chaser $VERSION" \
  --notes "<short human summary of what changed>"
```

Write the notes as a short plain-English changelog for Ben (he is the only
user); no PR-template or `[AI]`-prefix rules apply to release notes, but
keep the title format `Bread Chaser X.Y.Z`.

## Verify

```bash
gh release view "v$VERSION" --repo Jroll1125/Bread-Chaser
# - three assets listed
# - marked "Latest"
gh repo view Jroll1125/Bread-Chaser --json visibility   # PUBLIC
```

Installed apps (26.6.1+) pick the release up on next launch. The currently
running app updates on its next restart after the background download
completes.

## Gotchas

- `latest.yml` is what electron-updater actually reads; forgetting it (or
  the blockmap) makes updates silently never appear.
- A release must be NEWER (semver) than the installed version to be
  offered.
- If the exe was rebuilt after the release was created, delete and
  recreate the release (`gh release delete v$VERSION`) — the blockmap and
  yml hashes must match the exe byte-for-byte.
