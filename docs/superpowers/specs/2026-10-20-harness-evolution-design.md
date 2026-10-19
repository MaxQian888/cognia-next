# Harness Evolution — design

**Date:** 2026-10-20
**ADR:** [ADR-0237](../../content/docs/en/adr/0237-an-agents-harness-evolves-through-probed-approved-versions.md)
**Reference:** Harness² (arXiv 2610.14224, `google-research/harness2`, Apache-2.0), read at
source level: `core/recursion.py`, `tree.py`, `context.py`, `prompts.py`, `proposer.py`,
`selection.py`, `library.py`, `ledger.py`, `spec.py`, `schedule.py`.

## 1. Gap analysis

### 1.1 What Cognia already has

| Need | Existing implementation | Reuse decision |
| --- | --- | --- |
| One runtime for normal and probe runs | `resolveSendOptions` (`lib/claude/build-options.ts`) → `runAndCaptureAssistantReply` (`lib/claude/run-and-capture.ts`) | Probes and editor sessions use exactly this pair. No second runtime. |
| Headless run with an ephemeral agent | Eval Lab chat target (`lib/ai/eval/targets/chat.ts`): ephemeral `Character`, `cwd`, span capture, transient session cleanup | Same shape; harness probes add an overlay, a grant and evidence capture before cleanup. |
| Per-run customisation that can only narrow safety | `AgentCapabilityGrantV1` (ADR-0198) | Probe safety grant: deny side-effecting tools, no MCP unless allow-listed, no team/dispatch tools, permission cap, `maxBudgetUsd`, `maxTurns`. |
| Several configurations of one agent | Variants (ADR-0199), `resolveCharacterById` overlay | Workspace-scope adoption creates/updates an evolved variant and offers it as the workspace default. |
| Apply + rollback of an agent config with diff and unsafe-rollback refusal | `applyEvalRecommendation` / `rollbackEvalRecommendation` (`lib/ai/eval/recommendation-application.ts`), `evalConfigurationApplies` | New `agent-harness` configuration target; every adoption is an apply row; version history = those rows + immutable snapshots. |
| Blind A/B, judge, deterministic scorers, statistics | `@cognia/eval-core` (`buildBlindAssignments`, `deterministicScorers`, judge scorer, seeded random) | Contrastive evaluation and final selection. |
| Approval audit trail | Governance ledger (`recordDecision`, `appendDecisionEvent`, `recordLineageEdge`) as used by run learning | Adoption approvals and effects. |
| Run retrospective → approval-gated proposals | `lib/execution/run-retrospective.ts`, `run-learning-materializer.ts` | Failure-triggered mode starts from a retrospective of a failed run; a retrospective can recommend evolution. Not reimplemented. |
| Span tracing with OTel GenAI attributes | `agentTraces`, `assembleSampleFromSpans` | Metrics (tokens, cost, latency, tool errors) come from spans. |
| Tool calls with arguments/results | Session messages (AI SDK tool parts) | Trajectory rendering reads messages before the transient session is deleted. |
| Usage ledger | `recordSurfaceUsage`, `claimTurnUsage` | New usage surface `harness-evolution`; every probe/editor call booked with a deterministic operation id. |
| Pre-run estimates | ADR-0232 `estimateLaunchNow` | Displayed before start; never the cap. |
| Global spend gate | `enforceCostBudget` | Checked before each model step. |
| Isolated code workspaces | Task workspace bundles (`acquireWorkspaceBundle` with a frozen git base; ADR-0230) | `git` probe isolation on desktop. |
| Skill storage, validation, load context | `skills`/`skillResources`, `validateSkill`, `registerSkillLoadContext` | Candidate skills are in-memory rows registered in the run's load context; adopted skills are real rows. |
| Tool-loop middleware | `dispatchPreToolUse`, `tool.result.project` interceptor point, `onToolResultReview` on headless runs | Declarative tool rules (the eighth component) run here. |
| Settings, nav, agent console modes | `AppSettings`, `SETTINGS_NAV`, `AGENT_DETAIL_MODES` | `harnessEvolution` settings block, a settings section and an `evolution` agent mode. |
| Diff / compare / list UI | `LineDiffView`, best-of-N comparison, memory list + bulk bar | Candidate comparison, version history, experience library. |

### 1.2 What is missing

1. A harness model: no type says "the editable configuration that shaped this run"; no
   content hash over prompt + skills + tool guidance (the composition `promptDigest` skips
   `appendSystemPrompt`, `toolDigest` covers names only).
2. Guardrails / durable domain facts / tool guidance as first-class always-on text separate
   from the persona prompt.
3. In-memory candidate skills and subagents for one run.
4. Skill version history (skills overwrite in place).
5. Full trajectories as evidence (spans omit tool arguments by design; transcript renderers
   skip tool parts).
6. Propose–Probe–Compose, parallel/sequential recursion, selection, reflection.
7. A persistent, governed improvement library separate from memory.
8. A resumable, budgeted evolution job.
9. Probe-side side-effect interception for unattended runs.

### 1.3 Conflicts and risks

- **Memory vs experience.** `lib/memory/CONTEXT.md` says procedures belong to Skills; OWASP
  ASI06 forbids auto-ingesting agent output into trusted memory. Experiences therefore live in
  their own table with trust states and are never written to `memories`.
- **Skills are a shared global library.** Editing a skill in place for one agent changes every
  agent that uses it. Adoption forks on write: an evolved skill is a new row owned by the
  adopting agent (`canonicalId: harness:<characterId>:<slug>`).
- **Permissions.** The editable surface excludes model, provider, permission mode, tool
  allow/deny lists, MCP servers, sandbox and working directory (OWASP ASI03). Subagent tool
  lists are clamped to the parent's tools.
- **Non-reproducible environments.** MCP servers, web tools and connectors make reruns diverge
  and may cause side effects; probes deny them unless the user allow-lists read-only servers,
  and their rollouts are never cached.
- **Cost.** One step is 4k executor rollouts plus 3k editor sessions plus selection and
  reflection. Evolution is never automatic per message.
- **Web mode.** No filesystem and no tool-capable sidecar: probes degrade to text-only, the
  editor uses the structured channel, and only `none` isolation is available.

## 2. Architecture

```
lib/harness/                         pure core + ports
  tree.ts           snapshot components <-> editable file tree, path surface, diff, diversity
  validate.ts       tree validation (actionable messages fed back to the editor once)
  tool-rules.ts     declarative tool rules: schema, parse, apply (eighth component)
  snapshot.ts       capture, canonical hash, fork, component diff, runtime fingerprint
  overlay.ts        snapshot -> HarnessRuntimeOverlay for one run (build-options input)
  render.ts         always-on harness sections rendered into the system prompt
  trajectory.ts     UIMessage[] -> [ACTION]/[OBSERVATION]/[ERROR] trajectory
  evidence.ts       ExecutionEvidence assembly, redaction, caps
  context-tree.ts   editor evidence tree (task, rollouts, deliverables, harness, pool, library)
  prompts.ts        stage prompts (invariant, domain, compose, sequential compose, select, reflect)
  editor.ts         editor stage: one retry with validator feedback, then inherit
  checks.ts         deterministic rollout checks
  evaluate.ts       contrastive assessment, risk flags, hard gates
  select.ts         blind final selection that can keep the base
  budget.ts         budget estimate, ledger, reservation, stop reasons
  recursion.ts      runParallel / runSequential over ports
  machine.ts        run state machine
  cache.ts          rollout cache key + reproducibility policy
  risk.ts           diff risk class -> approval policy
  experience/       reflection parsing, library ops (dedupe, conflicts, capacity), retrieval
lib/harness/runtime/                 adapters on the real app
  probe-runner.ts   resolveSendOptions + runAndCapture with overlay, grant, isolation, capture
  probe-policy.ts   probe grant, permission auto-deny, preflight
  isolation.ts      none | files (scratch copy) | git (task-workspace bundle)
  editor-runner.ts  agentic channel (scratch dir + file tools) and structured channel (LlmClient)
  driver.ts         persisted, leased, resumable job driver
  adoption.ts       agent-harness apply/rollback, variants, skill fork-on-write, governance
  interceptor.ts    adopted tool rules on live sessions
lib/db/harness-evolution.ts          runs, steps, snapshots, experiences
```

### 2.1 The Cognia harness surface (C1–C8)

| Harness² | Cognia home | Editable path in the editor tree |
| --- | --- | --- |
| C1 system prompt | `Character.systemPrompt` | `systemprompt.md` |
| C2 guardrails | `Character.harness.guardrails` (new) | `guardrails.md` |
| C3 memory | `Character.harness.memory` (new; durable domain facts, not the Memory subsystem) | `memory.md` |
| C4 tool guidance | `Character.harness.toolGuidance` (new) | `tool_guidance.md` |
| C5 subagents | `Character.harness.subagents` (new) → `SendOptions.agents` | `sub_agents/<name>/AGENT.md` |
| C6 skills | skill rows referenced by `Character.skillIds` | `skills/<name>/SKILL.md` |
| C7 scripts | `skillResources` of kind `script` | `skills/<name>/scripts/<file>` |
| C8 plugins | `Character.harness.toolRules` (new; declarative) | `tool_rules.json` |

C2–C5 and C8 live on the `Character` profile, so variants inherit them and `ownFields`
shows exactly what an evolved variant changed. Scripts must travel with a skill: Cognia runs
helpers through the agent's own permission-gated shell, never itself.

Tool rules are the only middleware. Kinds: `error-hint` (append a hint when a tool's error
matches a pattern), `trim-output` (cap a noisy result), `call-cap` (deny further calls of a
tool past N with a teaching reason), `verify-after-write` (append a re-check reminder after a
write). A rule can add text, shorten output or deny; it can never allow, re-admit, or run code.

### 2.2 Snapshot

`HarnessSnapshotV1` is immutable and content addressed (`sha256` over canonical JSON of the
components plus the model/tool configuration it ran with). The configuration part is captured
for fingerprints and reproducibility but is not editable. Each skill keeps its source id and
source content hash, so drift of a shared skill invalidates cached rollouts.
`runtimeFingerprint` covers the app version, runtime kind, provider/model, enabled MCP server
ids and the tool-rule engine version.

### 2.3 Runs

A run has a task (prompt, optional input files or a git base, deliverable expectations,
deterministic checks, a domain), a base snapshot, a mode (`parallel` | `sequential`), `k`,
models per role (executor, editor, composer, selector, reflector), a budget and an adoption
scope. Steps are rollouts and editor sessions labelled exactly like Harness²
(`base1..k`, `inv1..k`, `dom1..k`, `agg1..k` / `c1..k`, `select`, `reflect`), so the ledger
identity R = 4k, P = 3k is checkable.

State machine: `queued → snapshotting → reference_running → proposing → probing →
composing → evaluating → awaiting_approval → adopting → reflecting → completed`, plus
`failed`, `cancelled`, `budget_exceeded`, `rejected`, `rolled_back` and `interrupted`
(resumable). Sequential runs loop proposing/probing/composing per round. Each step is
idempotent by label; on resume a completed step is reused, an in-flight rollout becomes
`interrupted` and is re-run only on an explicit resume (never silently re-spent).

### 2.4 Evaluation and selection

Order, as hard gates first:

1. Probe policy: denied side-effect attempts are recorded; a candidate whose run tried to use
   a denied capability is flagged; an edit that widens tools is rejected at validation.
2. Delivery and deterministic checks (expected files, output assertions via eval-core
   deterministic scorers, JSON schema, approved acceptance profiles for git tasks).
3. Trajectory contrast: tool failure rate, steps, tokens, cost, latency against the base set.
4. Blind selection (k > 1) over finals **and** the base reference, anonymised with a seeded
   shuffle; the selector must justify the pick and name the runner-up.
5. Decision: adopt only a final that passes every hard gate the base passes, is not worse on
   deterministic checks, and is chosen by the selector (or, at k = 1, wins a blind A/B against
   the base). Anything else keeps the base and records why.

### 2.5 Adoption

| Scope | Effect |
| --- | --- |
| task | Nothing persisted beyond the run record; the selected deliverable is the result. |
| session | The session switches to an evolved variant. |
| workspace | An evolved variant (`<agent> · evolved`) is created/updated; the user is asked whether to make it the workspace default agent. |
| global | The agent itself (or the variant itself) is updated. Always needs explicit approval. |

Risk class: `low` (tool guidance, memory facts, new skills), `medium` (system prompt,
guardrails, edits to existing skills), `high` (subagents, tool rules, scripts). Auto-adopt is
possible only for `low` at task/session scope when the setting allows it. Every adoption is an
`agent-harness` configuration apply with the previous projection stored; rollback refuses
after unrelated edits.

### 2.6 Experience library

Entries keep the adopted harness snapshot, edit attribution rows (`helped | hurt | no observed
effect | confounded`), at most one lesson (`cue`, `lesson`, `evidence`, `confidence`),
applicable/excluded conditions, scope (agent / workspace / global), domain, runtime
fingerprint, and status (`proposed | verified | rejected | deprecated`). A lesson resting only
on confounded rows stays `proposed`. Retrieval filters by visibility and domain, then ranks by
BM25 over cue/lesson/conditions plus structured matches (tools, failure kinds, model family),
penalising stale fingerprints. Add merges near-duplicates (line Jaccard over cue+lesson),
marks contradictions (opposite verdicts on the same component and domain) for review, and
evicts by utility past a per-domain cap. Experiences are inputs to the editor, never applied
automatically.

### 2.7 Budget

Limits: iterations (k), candidates, parallel runs, model calls, tokens, USD, wall time. Before
start the run shows the ADR-0232 estimate and the scheduled R/P counts. Before each step the
ledger reserves the worst observed cost of that step kind (or the estimate's p90 before any
observation) and refuses the step if the reservation exceeds what remains; the run then stops
with `budget_exceeded` and keeps the base. Each rollout also carries `maxBudgetUsd` and
`maxTurns` through its grant. All executor, editor, composer, selector and reflector calls are
booked on the `harness-evolution` usage surface.

### 2.8 Modes and triggers

`disabled` (default) | `manual` | `failure-triggered` (a failed or retried turn offers
"improve this agent" and pre-fills the task from the turn) | `background` (a scheduler
maintenance task drains queued failure-triggered tasks within a daily budget). Feature flag:
`AppSettings.harnessEvolution.enabled` (absent = off).

## 3. Security model

- Editors and selectors only see evidence as data (an explicit boundary in every prompt); in
  the agentic channel they run with read/write/edit/glob/grep confined to a scratch directory,
  no shell, no network tools, no MCP, no subagents.
- Evidence sent to a cloud model passes `hasNoLeakingPiiDeep` after `redactText`.
- Probe runs: transient session, isolated working directory, probe grant, sandbox network off
  where the runtime supports it, every ask-tier permission auto-denied and recorded.
- Locked components (user setting) and the excluded configuration fields cannot change.
- Adoption beyond task scope requires approval unless the low-risk auto-adopt setting applies;
  approvals and effects go to the governance ledger; plugins and paired devices get no adopt
  API.

## 4. Non-goals

Model weights, automatic library consolidation beyond dedupe/merge/evict, cross-account
experience sharing, and executable plugin generation.
