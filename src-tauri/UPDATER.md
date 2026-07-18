# Tauri Updater Setup

In-app auto-updates are **fully configured** and ready:

- `tauri.conf.json` → `bundle.createUpdaterArtifacts: true`, `plugins.updater.endpoints`
  set, and `plugins.updater.pubkey` **populated** with the real minisign public key.
- Plugin registered in `src-tauri/src/lib.rs`; least-privilege permissions
  (`updater:allow-check`, `updater:allow-download`, `updater:allow-install`, and
  `process:allow-restart`) granted in `capabilities/default.json`. The combined
  updater command and process exit command are intentionally not exposed.
- CI (`release.yml` → `build-tauri.yml`) builds + signs via `tauri-apps/tauri-action`
  with `releaseDraft: false`, so a tagged build **publishes** the release directly.
- Signing secrets `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` are already set in
  GitHub Actions.

**Nothing is left to configure** — the only reason the updater reports
`Could not fetch a valid release JSON from the remote` is that **no release has
been published yet**, so `releases/latest/download/latest.json` 404s. Cut the
first `v*` tag (step 4) and the endpoint goes live. Until then the boot-time
check logs this as a quiet `debug` (`about.autoUpdateCheckNoRelease`), not a warn.

The sections below document the one-time signing setup (already done for this
repo) so the steps aren't lost if the key ever needs rotating.

## 1. Generate a signing key pair

```bash
pnpm tauri signer generate -w ~/.tauri/cognia-next.key
```

You'll be prompted for a password (optional but recommended). It writes:

- `~/.tauri/cognia-next.key` — **PRIVATE KEY**, never commit
- `~/.tauri/cognia-next.key.pub` — public key (single line)

## 2. Paste the public key into config

Copy the single-line content of `~/.tauri/cognia-next.key.pub` into
`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. The app uses it at
runtime to verify update signatures. **(Already done — the field holds the live
public key.)**

## 3. Add the signing secrets in CI

In GitHub → Settings → Secrets and variables → Actions, add:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/cognia-next.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password (empty string if none)

`.github/workflows/build-tauri.yml` already reads these env vars and
`release.yml` forwards them via `secrets: inherit`. With
`createUpdaterArtifacts: true`, a **tagged** build FAILS without them by
design — an unsigned release would be un-updatable. **(Already done — both
secrets exist in this repo's Actions settings.)**

## 4. Ship

```bash
git tag v0.1.1 && git push origin v0.1.1
```

`tauri-action` builds every platform, signs the bundles, and creates a
**published** GitHub release with the installers, their `*.sig` signatures, and
the assembled `latest.json` manifest at:

```
https://github.com/MaxQian888/cognia-next/releases/latest/download/latest.json
```

— the endpoint configured in `plugins.updater.endpoints`.

> **Why published, not draft:** `releases/latest` resolves only to a published,
> non-prerelease release — a draft would leave the endpoint 404'ing. The repo
> sets `releaseDraft: false` so the release goes live as soon as the build
> finishes; the `quality` + `test` jobs gate the build first (see `release.yml`).
> The new tag must be a higher version than the installed app (e.g. an app at
> `0.1.0` only sees `v0.1.1+`).

The `latest.json` format is documented at https://v2.tauri.app/plugin/updater/.

## Runtime behavior

All renderer entry points reuse `lib/tauri/updater.ts`. The wrapper deduplicates
concurrent checks/downloads, closes superseded native update resources, applies
the configured request timeout and active network proxy, and downloads and
installs through separate Tauri commands. Settings → About controls the check
interval, background download, post-install relaunch, request timeout, and proxy
use. Installation remains user-confirmed even when background download is on.

## Notes

- OS trust signing is a **separate** concern from updater signing. macOS bundles
  use Tauri's ad-hoc identity (`bundle.macOS.signingIdentity: "-"`) so Apple
  Silicon does not reject Internet-downloaded builds as damaged. Ad-hoc signing
  is not notarization: users may still need to approve the app in Privacy &
  Security. Developer ID/notarization and Windows Authenticode remain optional
  production hardening.
- There is no `active` field in the Tauri v2 updater config — enablement is
  `createUpdaterArtifacts` + `endpoints` + `pubkey`.
