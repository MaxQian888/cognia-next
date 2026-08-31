---
"cognia-next": minor
---

DevTools gains a Plugin API calls inspector. Every `ctx.*` call a plugin makes into the host has been measured for a while (method, runtime, permission verdict, duration), but the only consumer was the trace bridge, which forwards a deliberately sampled subset to `/logs`. An author debugging a permission problem had to leave DevTools, open Traces, and hope their call was one of the sampled ones. The new pane, under Devtools → Advanced diagnostics, reads the same ring unsampled, with filters by plugin and outcome and a toggle that shows exactly which calls do reach Traces, so "my call isn't in Traces" stops being a mystery. It records metadata only: arguments and return values were never accepted into this ring and still are not.
