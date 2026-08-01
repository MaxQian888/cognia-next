---
"cognia-next": minor
---

Integrated terminal: real flow control, restored PATH injection, and a dock that can live on either edge.

Fixes: the `cognia` CLI and `~/.cargo/bin` are woven into dock shells again (the PATH injection was lost when the terminal moved to an out-of-process host, and the host cannot derive the app's managed-CLI registry on its own — it now arrives over the hello frame and is re-pushed when the in-app CLI download registers a new directory). A flood like `yes` now parks the PTY's reader at the source instead of overrunning the host's per-client queue and killing the tab outright. A desktop driving a remote Cognia host can create, split and clear terminals again — those affordances were gated on the local PTY transport. Right-clicking a tab opens that tab's menu, so rename / restart / close-others work on tabs other than the active one. The terminal panel's "Release control" is reachable for the first time. `terminal.sessionState.replayGap` used the wrong placeholder and rendered its raw key.

Adds: the dock can be docked at the bottom **or** on the right, dragged between the two by a grip on its tab strip (or switched from the dock toolbar), with an orientation-aware resize separator, keyboard resize, snap sizes and double-click-to-maximize. Tab strips gain drag-to-reorder, overflow fades and an overflow menu. The permanent badge stack across the top of every terminal is now one auto-collapsing status chip whose popover lists every state and hosts both halves of the control lease. An opt-in "Terminal (N)" status-bar segment shows session count and running state. The title bar's Terminal → New actually opens a terminal instead of only revealing the panel.
