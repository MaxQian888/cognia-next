---
"cognia-next": minor
---

The desktop top bar and bottom bar are now customizable, alongside the sidebar. Settings → Shell layout (and the "Customize layout" item on every surface's right-click menu) opens one editor with a tab per surface: the nav rail keeps its pin / More / hide buckets, and each bar gets a drag-to-reorder "In the bar" list plus a "Hidden" list. Every title-bar and status-bar segment is covered, not just the eight that had a checkbox before — including the app icon, back/forward arrows, search pill, command centre, git branch, notifications, attention, running jobs and the run-state readout.

Both layouts persist to your settings (so they sync with the rest of your setup rather than living in one browser's localStorage), and any segments you had previously turned off in the Views menu carry over. Hidden segments are unmounted rather than just invisible, so hiding the performance monitor stops its native sampling. Segments move within their own region of the bar — start, centre or end — since the window controls and the drag region are fixed; each row shows its region. Right-clicking the title bar now works on macOS too, offering "Customize layout".
