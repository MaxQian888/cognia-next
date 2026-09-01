---
"cognia-next": patch
---

The skills panel now offers native sync to a browser or phone paired to a Host, and says "skills are unavailable for the current host" instead of "requires desktop mode" when it genuinely cannot. The sync commands were already remote-reachable and the sync hook already checked the right predicate before acting, so only the disabled state and its tooltip were wrong.
