---
"cognia-next": minor
---

Unified agent execution (ADR-0090) phases 5–7: deployment certification lands
(signed compatibility manifests with staleness + per-capability circuit
breaking, a read-only certification panel, and billing-gated vendor
certification tooling); behind the `agentExecutionResolverV2` flag the unified
resolver becomes the single execution authority (fail-before-spend on
unsatisfied hard capabilities, explicit-only completion fallback with a
machine-readable `degradedReason` surfaced on workflow/team/plugin results);
and Agent Teams gain per-teammate execution bindings (inherit | pinned |
pool with a live delegation-mode preview), a team delegation depth cap
(default 2), rejection of new raw API-key/base-URL teammate writes, and one
run-wide budget authority with per-child usage/attempt/failure ledgers.
