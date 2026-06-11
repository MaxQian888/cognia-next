# Tauri Updater Setup

In-app auto-updates are **wired** (`tauri.conf.json` → `bundle.createUpdaterArtifacts: true`,
`plugins.updater.endpoints` set, plugin registered in `src-tauri/src/lib.rs`, CI on
`tauri-apps/tauri-action`). Two one-time secrets + the public key are all that's
left to make a tagged release self-updatable. Until then, the **manual** check in
Settings → About and the boot-time auto-check simply find nothing to install.

## 1. Generate a signing key pair

```bash
pnpm tauri signer generate -w ~/.tauri/cognia-next.key
```

You'll be prompted for a password (optional but recommended). It writes:

- `~/.tauri/cognia-next.key` — **PRIVATE KEY**, never commit
- `~/.tauri/cognia-next.key.pub` — public key (single line)

## 2. Paste the public key into config

Copy the single-line content of `~/.tauri/cognia-next.key.pub` into
`src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (currently an empty
placeholder). The app uses it at runtime to verify update signatures.

## 3. Add the signing secrets in CI

In GitHub → Settings → Secrets and variables → Actions, add:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/cognia-next.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password (empty string if none)

`.github/workflows/build-tauri.yml` already reads these env vars and
`release.yml` forwards them via `secrets: inherit`. With
`createUpdaterArtifacts: true`, a **tagged** build FAILS without them by
design — an unsigned release would be un-updatable.

## 4. Ship

```bash
git tag v0.1.1 && git push origin v0.1.1
```

`tauri-action` builds every platform, signs the bundles, and creates a **draft**
GitHub release with the installers, their `*.sig` signatures, and the assembled
`latest.json` manifest at:

```
https://github.com/MaxQian888/cognia-next/releases/latest/download/latest.json
```

— the endpoint configured in `plugins.updater.endpoints`.

> **Draft vs. latest:** the endpoint points at `releases/latest`, and a _draft_
> release is **not** "latest". Publish the draft (or set `releaseDraft: false`
> in `build-tauri.yml`) before the update becomes visible to clients.

The `latest.json` format is documented at https://v2.tauri.app/plugin/updater/.

## Notes

- OS code signing (Apple Developer ID / Windows Authenticode) is a **separate**
  concern from updater signing and stays disabled; it is not required for in-app
  updates. Unsigned installers still update fine via the updater signature.
- There is no `active` field in the Tauri v2 updater config — enablement is
  `createUpdaterArtifacts` + `endpoints` + `pubkey`.
