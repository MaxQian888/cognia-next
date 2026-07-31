---
"cognia-next": minor
---

The right-hand workbench now leaves its icon rail on screen when you close it (ADR-0098). Collapsing shrinks the column to the activity icons instead of hiding it entirely, dragging that rail's edge reopens it at the width you left it at, and releasing the divider snaps to the nearest width preset or back to the rail. Applies to the chat dock, Canvas, the workflow editor and the project editor; a new "Keep the icon rail on screen" switch in the workbench customizer restores the old collapse-to-nothing behaviour. Also fixes a toggle that needed two presses after dragging the dock shut, and plugin panels that reported themselves visible while the whole column was closed.
