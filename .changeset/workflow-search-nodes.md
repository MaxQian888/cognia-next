---
"cognia-next": minor
---

Workflows can search. Two new nodes: one runs the command palette's own engine and providers over conversations, memories, workflows, issues, skills and the rest, the other searches message text and returns the excerpt around each hit.

Both are scoped to the run's workspace unless you widen them, and both report honestly on what they could not see: a provider that fails becomes an errored group instead of a failed run, a per-kind limit that withheld results says so, and chat search distinguishes "there is more history, ask for it" from "the index has not caught up yet". Results carry ids and titles rather than the palette's click handlers, and the run log gets counts rather than the result set.
