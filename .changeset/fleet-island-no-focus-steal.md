---
"cognia-next": patch
---

Fleet island no longer steals keyboard focus when it appears. The island is a passive status overlay (a non-activating `NSPanel` on macOS), but its 8-second "force-show" fallback — which fires when the renderer is slow to signal first paint, e.g. on a cold start — used `bring_window_to_front`, which also `set_focus()`es and pulled focus away from whatever you were doing (especially an app on another display). The fallback now reveals the window in place without focusing it.
