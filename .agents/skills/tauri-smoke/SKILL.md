---
name: tauri-smoke
description: Smoke-test Cognia's real Tauri shell after changes to commands, IPC payloads, windows, tray, sidecars, capabilities, or desktop-only transport. Use when unit tests cannot prove the renderer-to-Rust boundary or when asked to verify desktop behavior.
---

# Tauri Smoke (minimal, standardized)

Unit gates don't cover the shell boundary: serialization shape mismatches
(Rust tuple → JSON array), unregistered commands, capability denials, and
secondary-window issues only surface in a running shell. This is the minimal
procedure so smoke stops being deferred.

## When it is REQUIRED (not optional)

- New/changed `#[tauri::command]` signature or return type
- Changed event payload shapes crossing IPC
- Window management: secondary windows (pet), tray, window flags
- `tauri.conf.json` / `src-tauri/capabilities/*` changes
- Sidecar spawn/handshake changes
- Anything the change log describes as "works in web mode, needs Tauri"

Pure UI/logic changes verified in `pnpm dev` web mode do NOT need this.

## Procedure (~5 min)

For an agent-driven or repeatable flow, use `$tauri-agent-debug` instead of
manual clicking; it supplies authenticated launch, semantic actions, console /
network / native-log evidence, screenshots, and tracked shutdown in the real
Tauri shell. Keep this manual procedure for seams the semantic bridge cannot
exercise, such as tray menus and OS-native drag behavior.

1. Start `rtk pnpm tauri dev` in a dedicated terminal and wait for the window.
   (`predev` scripts run automatically; don't bypass them.)
2. **Boot check**: main window renders past the splash; DevTools console has
   ZERO new errors vs. before your change (boot console errors have been
   real regressions here twice).
3. **Exercise YOUR seam** — the one the change touched:
   - New command → trigger its UI path once; confirm a real (non-error)
     result, watching for "command not found" (= missing
     `generate_handler!` entry) and shape mismatches (tuple→array).
   - Event/stream → trigger one emission, confirm the renderer reacts.
   - Secondary window/tray → open/close it once; drag if drag changed.
   - Sidecar → confirm handshake log and one round-trip.
4. **One adjacent surface**: open one unrelated heavy page (e.g. chat or
   workflows) to catch capability/CSP regressions.
5. Quit the app and stop the exact dev process you started. On Windows, leftover dev
   processes hold file locks — make sure the process tree is dead before
   `git worktree remove` or builds.

## Reporting

State exactly what was exercised: "smoke: boot clean, `<command>` round-trip
OK, pet window drag OK" — or "tauri smoke NOT done because <reason>" so the
loose end is explicit, never implicit.

## If something only fails in the shell

Check the nearest seam in this order: command registration in
`src-tauri/src/lib.rs`, the command permission and capability grant under
`src-tauri/permissions/` and `src-tauri/capabilities/`, serialized payload
shape (prefer a named `Serialize` struct), then webview-versus-Node API usage.
