---
"cognia-next": patch
---

Right-side dock: stop the layout flash when switching to the Workspace or Prompt Templates panel. The resize animation was torn down one frame after it started by the layout echo it triggered itself, and a workspace panel's requested width was clamped by a sizing profile that had not been written yet — together they snapped the dock while its contents were briefly laid out at the destination width, blinking a scrollbar in and out of the panel body.
