---
"cognia-next": patch
---

A chat whose managed workspace cannot be materialized on this device now records that refusal instead of swallowing it. The failure was caught and discarded at session creation, leaving the workspace state undefined and so indistinguishable from "never attempted". The first turn failed instead, deep in bundle setup, reporting the name of an internal object behind a Retry that re-ran the same refusal. The session now carries `missing-on-device` and raises a `workspaceUnavailable` diagnostic at the point of failure.
