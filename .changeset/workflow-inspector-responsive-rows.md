---
"cognia-next": patch
---

Workflow inspector: paired fields now stack instead of squashing in a narrow panel. Every two- and three-column row in the node inspector (48 of them, across AI, scheduler, terminal, goal, plan, team, connector, mobile, trigger and error-handling forms) was a hard-coded grid that kept its columns no matter how much room the panel had. The inspector lives in the Context Workbench, which drags down to 240px and is re-hosted full-bleed inside a sheet on mobile — at those widths each column got roughly 85px, enough to truncate every dropdown label and clip the number steppers. Rows now size against the panel itself: one column while it is narrow, two once there is room, and a third only on the widest rows. A pinned test keeps new forms from reintroducing a fixed-column grid.
