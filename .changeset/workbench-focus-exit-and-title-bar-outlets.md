---
"cognia-next": patch
---

Right-hand workbench: maximizing it (Focus) no longer strands the way back out. The takeover covers the title bar and marks it inert, so the header it projects into — the narrow / wide / focus buttons — was drawn underneath and could not be clicked; it now comes back inside the takeover for as long as that surface owns the viewport. Pressing the lit Focus button dismisses it too, instead of re-selecting the mode it was already in.

Top bar: opening the workbench to its `wide` preset no longer starves the bar's own row. The end outlet tracked the dock exactly — half the window for a header of four right-aligned icons — which truncated the conversation title to a single character beside a wide band of empty outlet. The centre now keeps at least half the bar, taking it back from the empty leading part of the outlet (nothing that is drawn moves), and the centring counterweight stands down while the centre is at that floor.
