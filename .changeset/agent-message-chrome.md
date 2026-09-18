---
"cognia-next": patch
---

Rework the assistant message chrome into the same row language the activity stream uses: the header leads with the breathing status dot and names the actual preset/agent the turn ran under (name + icon sealed into run metadata at completion, so history keeps the identity that produced it); thinking renders as a violet `THINK` activity row instead of a standalone block; and the per-field run metadata collapses into a compact summary on the action row that opens an anchored popover instead of expanding inline.

Converge the remaining activity/status parts onto the same shared row: subagent runs, simplified tool-call rows, hook notices, squad runs and gates, verification verdicts, agent-team dispatches, grounding warnings, tool-use summaries, and unknown-part diagnostics now render as status-dot rows with hover actions and details nested under a left rule instead of their former cards, dashed boxes, and colour-bar strips.
