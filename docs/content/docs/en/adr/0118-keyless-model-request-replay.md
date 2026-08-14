---
title: "ADR-0118: Keyless deterministic model-request replay"
description: "Record the real request surface once, replay agent runs with no API key"
---

# ADR-0118: Keyless deterministic model-request replay

- Status: Accepted, staged rollout
- Date: 2026-08-14

## Context

Nothing in the system records what was actually sent to a model. The final
system prompt, the normalized message list, the tool schemas and their order,
and the resolved request configuration are assembled across
`lib/claude/build-options.ts`, the execution resolver, and the sidecar, and then
discarded. A regression in prompt or tool assembly is therefore invisible until
a human notices bad behaviour, and no agent-level test can run in CI without a
real API key.

The pieces to build on already exist. Eval Lab (ADR-0101) has encrypted
artifacts (`lib/ai/eval/artifact-crypto.ts`, `lib/ai/eval/assets.ts`), portable
bundles (`lib/ai/eval/replay-bundle.ts`, `packages/eval-core/src/portable.ts`),
and a `cognia eval` CLI with `preflight`, `run`, `import`, `status`, `report`,
and `export`. The E2E suite already boots a local mock Anthropic server
(`tests/e2e/mocks/anthropic/server.ts`), which proves the localhost approach but
only covers wire-level chat for browser specs. The durable
`AgentEventEnvelope` log already exists and already requires consumers to ignore
unknown event kinds, so its vocabulary can grow additively.

## Decision

Three versioned contracts land in `packages/agent-config-types`:
`ModelRequestSurfaceV1` (identity lineage, runtime, provider, model, purpose,
resolved config, prompt/message/tool-schema references and digests, the
ADR-0117 composition digest, the existing execution fingerprint, and a request
digest), `ReplayScenarioV1` (actor, input steps, platform, replay level,
permission script, workspace seed, expectations), and `ReplayTapeV1`
(normalized match conditions plus the model stream, error, cancel, or hang
behaviour to serve).

One additive canonical event kind, `model-request`, carries digests and
encrypted-artifact references only — never prompt or response bodies. No second
event bus is introduced.

Replay has two levels. **Canonical replay** re-plays `AgentEventEnvelope`
frames and validates renderers, recovery, permission state, and parent/child
logs. **Runtime replay** runs the real SDK, agent loop, tool pipeline,
permission system, and persistence, and substitutes only the model endpoint
with a local tape server.

Requests are matched per actor, not globally: each parent and child actor takes
its own replay lease and matches a normalized request digest against its
unconsumed tapes, so concurrent children cannot desynchronize each other. Two
tapes with the same digest and different responses inside one actor fail
fixture construction rather than being matched fuzzily. Every run ends with
`assertConsumed`, which fails on missing requests, extra requests, unconsumed
permission entries, unfinished children, and orphaned logs.

Storage reuses the eval encrypted-asset store and the `.cognia-eval` bundle,
extended with `model-request`, `model-stream`, `permission-tape`,
`session-log`, `transport`, and `workspace-manifest` artifact kinds. Recording
is opt-in: an ordinary run persists digests and references only. Capture sits
after the PII gate, and authorization headers, API keys, and sensitive
environment values are never captured. Real recordings stay encrypted and out
of git; a fixture may only be committed if it is marked synthetic and passes
the secret and PII scan. Replay allows loopback network only and a disposable
workspace. Deleting an eval asset deletes the replay artifact references with it.

`cognia eval` gains `record`, `replay`, and `refresh`. `record` requires an
explicit live flag and runs serially; `replay` runs with no key against
read-only fixtures; `refresh` may only regenerate derivable goldens and must
never re-record a model tape. Eval Lab gets a separate Replay workspace for
import, preflight, run, diff, and an explicit refresh approval.

Claude Agent SDK is implemented first, by extending the existing localhost mock
harness with a permissionless placeholder token that satisfies the SDK's
argument validation without being a credential and without any outbound
request. AI SDK follows with a local provider adapter. External and ACP agents
use a scripted peer; when an external agent does not expose its internal model
requests, only the wire protocol and canonical events are captured, and the
report declares the reduced fidelity rather than claiming a full snapshot.
Browsers support canonical replay only; runtime replay requires a Tauri or
headless host and states that reason when unavailable.

## Reused ownership

No new database, event bus, crypto scheme, or CLI is created. This extends the
eval artifact store and bundle format, the `cognia eval` command, the canonical
event vocabulary, the existing E2E mock harness, and the existing permission and
sandbox systems. Agent RPC and the execution resolver keep ownership of runtime
routing; replay only substitutes the model endpoint.

## Compatibility and rollback

`model-request` is additive, and older consumers ignore unknown kinds. Recording
is off by default and gated by a flag; turning it off leaves already-written
artifacts readable under their existing retention policy. Replay suites ship as
optional checks and are promoted to merge gates only once stable, so a
regression in the harness cannot block unrelated work.

## Consequences

Prompt, tool-schema, permission, and lineage regressions become diffable, and
agent-level suites run in CI with no key and no egress. The costs are a
recording path that must stay behind the PII gate, a fixture corpus that has to
be curated as synthetic, and an explicit fidelity ladder for external agents
that cannot be papered over.
