# Tauri Updater Setup

This template ships the `tauri-plugin-updater` plugin **disabled** (`tauri.conf.json` → `plugins.updater.active = false`). Follow these steps to enable in-app updates.

## 1. Generate a signing key pair

```bash
pnpm tauri signer generate -w ~/.tauri/react-quick-starter.key
```

You'll be prompted for a password (optional but recommended). The command writes:

- `~/.tauri/react-quick-starter.key` — **PRIVATE KEY**, never commit
- `~/.tauri/react-quick-starter.key.pub` — public key

## 2. Wire the public key into config

Copy the **single-line** content of `~/.tauri/react-quick-starter.key.pub` into
`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

## 3. Configure the update endpoint

GitHub Releases is the simplest host. Set:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/AstroAir/react-quick-starter/releases/latest/download/latest.json"
    ],
    "pubkey": "<paste public key here>"
  }
}
```

The `latest.json` file format is documented at https://v2.tauri.app/plugin/updater/.

## 4. Sign builds in CI

Set the following GitHub Actions secrets:

- `TAURI_PRIVATE_KEY` — base64-encoded contents of your private key file
- `TAURI_KEY_PASSWORD` — the password (empty string if you skipped one)

The existing `.github/workflows/release.yml` references these env vars in the
Tauri build step (currently behind comments — uncomment when ready).

## 5. Flip `active` to `true` and ship

```diff
- "active": false,
+ "active": true,
```

Tag a release. The updater will check the configured endpoint on app startup.
