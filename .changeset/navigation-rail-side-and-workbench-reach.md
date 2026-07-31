---
"cognia-next": minor
---

Move the navigation rail to whichever window edge you want, and make the right-hand workbench reachable without the mouse.

The rail now defaults to the right edge, with a Left/Right toggle in Settings → Sidebar (or its right-click "Customize layout"). It stays part of the app shell, so every route keeps its navigation — moving it does not turn it into a chat-only panel. Tooltips and the "More" popover open inward from whichever edge it takes, and on the right it gains a border, because the rail and the workbench beside it share a wallpaper scope and tone alone left no seam between them. The mobile drawer is unaffected.

The command palette gained the navigation it never had: every top-level destination — including ones you hid from the rail — plus Direct Messages, Canvas, and the panels of whichever workbench is in front. That last group is also what `Ctrl+1`…`Ctrl+7` now reach, one chord per activity (preview/run, review, AI, comments, inspect, workspace, templates). A chord whose activity the current surface does not offer does nothing rather than landing on a neighbouring panel.

The workbench's activity rail is customizable at last: drag to reorder, hide the activities you never use, restore defaults — on a new "Workbench" tab beside the existing sidebar and window-bar editors. Hiding removes only the icon; the panel stays reachable from the palette and its shortcut.

Selection now moves instead of blinking. The rail, the workbench activities and the artifact tabs share one highlight that springs from the old item to the new one, and the dock's width transition, its divider fade and the collapsible agent-flow bodies all run on the shared motion tokens rather than three separately hand-tuned curves. Everything collapses to an instant swap under reduced motion.
