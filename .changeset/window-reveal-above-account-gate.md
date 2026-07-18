---
"cognia-next": patch
---

Fix the desktop app occasionally booting to a black window that never shows the lock/create screen. The Tauri main window is created hidden (`visible:false`) and revealed by `WindowShowInitializer` on the renderer's first paint, but that initializer (and the white-screen watchdog heartbeat) lived inside `DesktopOnlyInitializers`, which mounts _below_ `AccountGate`. On every desktop cold boot the account gate first renders the create-account or unlock form and never mounts its children, so the reveal never fired — the window stayed black until the Rust 8-second force-show fallback (which logged "renderer never signaled first paint" on every boot). The reveal and heartbeat now run in a new `WindowLivenessInitializers` mounted above the account gate, so the themed lock/create screen appears as soon as it paints instead of after an 8-second black window.
