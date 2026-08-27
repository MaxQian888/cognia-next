---
"cognia-next": minor
---

Diagnose Pi's credentials before the first prompt, and offer to install Pi when
it is missing. A new "Pi credentials" card on a connected native-Pi agent asks
Pi which providers it can actually authenticate — read-only, via `pi auth check
--no-refresh`, so Cognia still never reads, refreshes or stores a Pi credential.
"Pi has no usable model" now shows up as a diagnosis instead of as a failed
first turn, and a probe that could not run says so rather than blaming your
credentials. The CLI's install prompt also knows about Pi now: a missing `pi`
used to offer neither an install command nor a docs link.
