---
name: tauri-smoke
description: Minimal desktop-shell smoke procedure for cognia-next. Use after changes to Tauri commands, IPC payload shapes, windows/tray, sidecar wiring, or capabilities — jest and cargo test pass on changes that still break the real shell, and "tauri smoke NOT done" is a recurring loose end.
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

1. Start: `pnpm tauri dev` in background; wait for the window.
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
5. Quit the app, stop the dev process. Note: on Windows, leftover dev
   processes hold file locks — make sure the process tree is dead before
   `git worktree remove` or builds.

## Reporting

State exactly what was exercised: "smoke: boot clean, `<command>` round-trip
OK, pet window drag OK" — or "tauri smoke NOT done because <reason>" so the
loose end is explicit, never implicit.

## If something only fails in the shell

It's almost always one of: command not registered (`lib.rs`), capability
missing (`src-tauri/capabilities/`), serialization shape (use a named
Serialize struct, not tuples), or webview-vs-node API difference. Check
those four before deeper debugging.
