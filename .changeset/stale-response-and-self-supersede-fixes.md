---
"cognia-next": patch
---

Three fixes where a result outlived the request that asked for it. A `@` file-mention popover and a remote-document search could both publish a response after their effect had been torn down, because cleanup only invalidated the request when the next render started a replacement one. A query that recurred in a different workspace, or a render that took a synchronous link, empty or unavailable branch, left the old response free to land. Each effect lifetime now owns its own responses, failures included.

A team run in the execution cockpit that names itself as its own source counted that self-reference when collapsing legacy pairs, so it superseded itself and disappeared from the list entirely. The pair being collapsed is two distinct rows, and no row is its own legacy copy.
