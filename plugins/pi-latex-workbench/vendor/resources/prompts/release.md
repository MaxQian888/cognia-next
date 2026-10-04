---
description: Prepare a formal LaTeX release with host review and approval gates
---

# Release task protocol

Load `skill:latex-release` through `latex_project resource`. Confirm the current
snapshot and target, use `prepare` for the plan, and build the candidate. Run the
required checks and render the required pages. The first `package` call freezes
the candidate; retain the returned `releaseId` and approval evidence artifacts.
Human page reviews
and digest-bound grants must come from the host; the agent cannot record them.
After the host supplies them, retry `package` with the same releaseId, verify its clean-room
rebuild result, and report final artifacts and remaining blockers. Never downgrade
a profile to bypass a gate. For a request that only needs a draft PDF, use the
ordinary build flow instead.

User request: $@
