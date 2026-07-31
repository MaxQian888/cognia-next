---
"cognia-next": patch
---

Fix mid-run follow-ups being delivered to the wrong agent, or dropped. The steer path asked the composer's global runtime selector which agent to steer, but that answers "what the next turn I start will use" — in split view a follow-up typed into a background pane consulted the focused pane's choice, steering the wrong agent or missing the live lane entirely. Each turn now records the lane it actually dispatched on and clears it when it settles.

A follow-up typed while a turn is paused on a tool approval is now delivered live rather than queued — the composer stays writable there precisely because redirecting matters most at that moment. An attachment-only follow-up goes live on the built-in path instead of queueing. And the optimistic bubble is written to the database as it appears, so a follow-up killed by a restart before delivery survives as "Not delivered" instead of vanishing.
