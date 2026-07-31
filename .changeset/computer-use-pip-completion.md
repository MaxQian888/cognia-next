---
"cognia-next": minor
---

Finish the Computer Use picture-in-picture surface in chat. It now sizes itself to the captured screen's real aspect ratio (no more black bars), shows a relative "just now / Ns ago" freshness label so a between-screenshots frame no longer looks live, and reaches an explicit "Done" (or error) terminal when the turn ends before auto-collapsing to the pill. A manual hide only affects the current run — the next Computer Use activity re-expands it — and the surface clears itself when you switch sessions.

You can now drag the window anywhere in the chat pane (it snaps to the nearest corner on release, still avoiding the thread controls) and resize it from the corner grip, click the frame to view the screenshot larger, and close it outright for the current run. Activity is announced through an accessible live region for screen-reader users. Enter/exit, corner-move and frame changes are animated, all respecting reduced-motion, and the reposition control uses a clearer icon with tooltips.
