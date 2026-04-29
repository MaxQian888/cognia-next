# API Key Storage: Migration to OS Keyring

**Status**: design only — not implemented in the current release.
**Tracking task**: B6 of the AgentTeam + Settings iteration plan.

## Problem

The Anthropic API key is currently stored in IndexedDB as a plain string
(`AppSettings.apiKey`). The settings UI explicitly tells the user this is a
v1 trade-off. The next iteration should move the key into an OS-managed
secret store so the disk image of the user's profile no longer carries the
key in clear text.

## Approach

Use the [`keyring`](https://docs.rs/keyring/) Rust crate from the Tauri
sidecar. It wraps:

- macOS Keychain
- Windows Credential Manager
- libsecret (GNOME) / kwallet (KDE) on Linux

All three are encrypted-at-rest under the user's login credentials and are
the standard practice for desktop apps holding API keys.

## Tauri commands to add

```rust
// src-tauri/src/api_key.rs (extends the existing in-process key cache)

#[tauri::command]
pub async fn keyring_set_api_key(state: State<'_, ApiKeyState>, key: String) -> Result<(), String> { … }

#[tauri::command]
pub async fn keyring_get_api_key(state: State<'_, ApiKeyState>) -> Result<Option<String>, String> { … }

#[tauri::command]
pub async fn keyring_delete_api_key(state: State<'_, ApiKeyState>) -> Result<(), String> { … }
```

Service name: `cognia-claude` (matches the Dexie database name).
Account name: `anthropic-api-key`.

## One-shot migration

Run on app start, before the first sidecar launch:

1. Read `AppSettings.apiKey` from IndexedDB.
2. If non-empty AND keyring has no entry yet:
   - Write the key to keyring via `keyring_set_api_key`.
   - Clear the field in IndexedDB (`saveSettings({ apiKey: undefined })`).
3. Always source the key from the keyring afterwards.

The existing `claude_set_api_key` Rust command (in-process Arc<RwLock<…>>)
stays — keyring is the _durable_ layer; the in-process cell is what the
sidecar reads. They're populated together.

## Frontend changes

- `useSettingsStore.setApiKey(key)`:
  - In Tauri: write to keyring, clear `AppSettings.apiKey`, update the
    in-process cache, restart the sidecar.
  - In web: keep the IndexedDB write path (no keyring available).
- `ApiKeySection`:
  - Read the masked status from the keyring (boolean: "set" / "not set"),
    not from IndexedDB.
  - On clear: call `keyring_delete_api_key`.

## Capabilities

`src-tauri/capabilities/default.json` does not need changes — the keyring
crate works through the OS, not via a Tauri plugin scope.

## Testing

- Migration idempotency: run app once with a key in IndexedDB, confirm
  keyring has the key and IndexedDB no longer does. Re-run; nothing
  changes.
- Cross-platform: validate the three back-ends (macOS, Windows, Linux)
  manually before release.
- Web mode parity: ensure web fallback still works (IndexedDB-only).

## Out of scope here

- Per-profile keys (multiple Anthropic accounts in one app install).
- Encrypted backup of the keyring entry. Users can re-enter the key.
- Changing the wire format between sidecar and SDK — already env-based.
