---
"cognia-next": minor
---

Context Workbench: split view is now real. On desktop in Wide or Focus mode the layout menu offers "Split below", stacking a second panel under the one in front with a draggable divider (also resizable from the keyboard) whose ratio is remembered per resource. Navigating to the panel already in the lower pane swaps the two and keeps each at the height it had; the mobile drawer and any workbench too narrow for two panes fall back to a single pane without disturbing the stored desktop layout. Both panes stay live — each keeps focus, its own error boundary, and its plugin visibility signal — and neither is rebuilt when the split opens, closes, resizes or swaps, so embedded editors, browsers and terminals survive the gesture. Replaces the disabled "Split view (not available yet)" entry, which now explains what to switch to instead of only saying no.
