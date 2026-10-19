---
title: "0237 — An agent's harness evolves through probed, approved versions"
description: "Adds Harness Evolution: an agent's prompt, guardrails, facts, tool guidance, skills, scripts, subagents and declarative tool rules are captured as content-addressed snapshots, improved by Propose–Probe–Compose on the same runtime that serves chat, adopted only through approved, reversible versions, and distilled into a governed experience library."
---

# ADR 0237 — An agent's harness evolves through probed, approved versions

**Status:** Accepted
**Date:** 2026-10-20
**Related:** ADR-0090, ADR-0101, ADR-0189, ADR-0198, ADR-0199, ADR-0202, ADR-0230, ADR-0232

## Context

An agent's behaviour depends on more than its model: the persona prompt, standing rules,
durable domain facts, how tools should be used, which skills it can load, the helpers those
skills carry, the subagents it can delegate to, and middleware in the tool loop. In Cognia
these are edited by hand after a run goes wrong.

Harness² (arXiv 2610.14224) shows that this configuration can be improved per task, without
ground truth, by proposing edits, executing them on the same task, and composing a successor
from the behavioural contrast; and that a library of evidence-backed lessons improves later
tasks. Its release is a research system: a Python driver, file trees on Linux, executors with
unrestricted network and a disabled Codex sandbox, no approval step, a library with no
capacity control, and a final selector that the paper's own failure analysis shows can pick a
worse output.

Cognia already has most of the machinery such a loop needs: one resolver for a run's options
(`resolveSendOptions`), headless runs with an ephemeral agent (the Eval Lab chat target),
narrow-only per-run grants (ADR-0198), agent variants (ADR-0199), configuration apply and
rollback with diffs (ADR-0101), blind A/B and deterministic scorers (`@cognia/eval-core`), a
governance ledger, isolated git workspaces (ADR-0230), a usage ledger and run estimates
(ADR-0232), and a run-learning proposal flow.

## Decision

### The harness is part of the agent profile

The editable harness has eight components, mapped onto Cognia instead of onto files:
`Character.systemPrompt`; a new `Character.harness` holding `guardrails`, `memory` (durable
domain facts — not the Memory subsystem), `toolGuidance`, `subagents` and `toolRules`; the
skills in `Character.skillIds`; and script resources carried by those skills. Because the new
fields are profile fields, variants inherit and own them like any other.

Model, provider, permission mode, tool allow/deny lists, MCP servers, sandbox and working
directory are captured but never editable by evolution. Subagent tool lists are clamped to the
parent's tools. Users can lock further components.

The eighth component is **declarative**: `error-hint`, `trim-output`, `call-cap` and
`verify-after-write` rules applied by a built-in tool-loop interceptor (and by the
`onToolResultReview` / permission responders on headless runs). A rule can add text, shorten
output or deny a call. It cannot allow, re-admit or execute anything. No model-written code
runs as middleware.

### Snapshots are immutable and content addressed

A `HarnessSnapshotV1` holds the components plus the configuration they ran with and a runtime
fingerprint, hashed as canonical JSON with SHA-256. For editing, a snapshot is projected to a
file tree (`systemprompt.md`, `guardrails.md`, `memory.md`, `tool_guidance.md`,
`skills/<name>/SKILL.md`, `skills/<name>/scripts/*`, `sub_agents/<name>/AGENT.md`,
`tool_rules.json`) and parsed back; anything off that surface is rejected with an actionable
message.

### Probes use the chat runtime

A probe is `resolveSendOptions` + `runAndCaptureAssistantReply` for a transient session,
exactly like the Eval Lab target, with three additions passed as inputs, never as patches:
`BuildOptionsContext.harnessOverlay` (candidate sections, in-memory skills and resources,
subagents, tool rules), a probe capability grant (no MCP unless allow-listed, no team or
dispatch tools, known side-effecting tools denied, permission cap, turn and USD caps), and an
isolated working directory (`none`, a scratch copy of input files, or a task-workspace bundle
at a frozen git base). The grant caps the permission mode at `default`, so every mutating call
reaches a decision instead of a mode shortcut. A probe-specific responder answers those
decisions unattended: file tools are allowed only inside the rollout's directory, shell
commands only when the shared command classifier finds no remote, global install, privileged
or system command and no path outside the directory, and everything else is denied and
recorded on the rollout. First-party plugin tools are reduced to a short allowlist. The
trajectory, deliverables, spans and usage are captured before the session is deleted.

### Propose–Probe–Compose, parallel and sequential

The loop follows Harness²: k reference rollouts; invariant and domain editors; one rollout per
candidate; composition from all evidence; parallel (2k candidates, k compositions) or
sequential (k rounds carrying the checkpoint and history). Editors read an evidence tree
(task, full trajectories, deliverables, current harness, candidate pool with diffs, earlier
decisions, library entries) and return an edited tree. An invalid tree gets one retry with the
validator's message, then the stage inherits the current harness. On desktop editors run as
agent sessions confined to a scratch directory with file tools only; elsewhere they use a
structured channel that returns the edited files as JSON.

### Selection can keep the base, and deterministic checks come first

Hard gates (probe policy, delivery, deterministic checks, approved acceptance profiles) run
before any model judgement. The blind selector compares the finals **and** the base reference;
at k = 1 the composed harness must win a blind A/B against the base. When nothing passes the
gates the base passes, or the judgement is uncertain, the base is kept and the reason recorded.

### Adoption is a reversible version

Every adoption beyond the task is an `agent-harness` configuration apply (the ADR-0101
mechanism): the previous projection is stored, a field-level diff is shown, and rollback
refuses after unrelated edits. Session scope switches the session to an evolved variant;
workspace scope creates or updates an evolved variant and asks whether to make it the
workspace default; global scope updates the agent. Evolved skills are forked on write, never
edited in place, because skills are shared. Risk classes (`low`, `medium`, `high`) decide
whether approval is required; only low-risk task/session adoptions may be automatic, and only
when the user enabled it. Approvals and effects are written to the governance ledger. Plugins
and paired devices have no adopt API.

### Experiences are governed, not memories

After a run, a reflector writes edit attribution rows and at most one lesson. Entries keep the
adopted snapshot, conditions, scope, domain, runtime fingerprint and a status. A lesson backed
only by confounded rows stays `proposed`. Retrieval combines visibility, domain, structured
matches and BM25. Adding merges near-duplicates, flags contradictions for review and evicts by
utility past a cap. Experiences are inputs to editors; they are never written to `memories`
and never applied without a new probe.

### Cost is explicit

A run schedules R = 4k rollouts and P = 3k editor sessions plus selection and reflection. The
ADR-0232 estimate is shown before start; caps on iterations, candidates, parallelism, model
calls, tokens, USD and wall time are enforced by reserving each step's worst observed cost
before it starts. Spend is booked on a new `harness-evolution` usage surface. The feature is
off by default, and modes are `manual`, `failure-triggered` and `background`; nothing runs per
message.

## Implementation

The engine is pure modules under `lib/harness/` with adapters in `lib/harness/runtime/`,
four Dexie tables (`harnessSnapshots`, `harnessEvolutionRuns`, `harnessEvolutionSteps`,
`harnessExperiences`, schema v247) and the UI in `components/harness/`. It is desktop-only:
the settings section, the initializer and the background sweep are mounted on desktop, and a
paired client whose Host owns the conversations does not start runs.

### The run is a leased job

The state machine is `queued → snapshotting → reference_running → proposing ⇄ probing ⇄
composing → evaluating → reflecting → awaiting_approval → adopting → completed`. Reflection
runs right after the decision and before the run waits on a person, so an approval that takes
days holds no work and every model call is spent while the run is active; a failed reflection
does not fail the run. A keep-base decision ends after reflecting, and a low-risk decision
that settings allow to auto-adopt skips `awaiting_approval`.

One driver owns a run through a renewed lease, and every run write is a compare-and-swap on a
`version` field: a cancel from another window or a resumed driver wins, and the losing driver
stops without writing. Steps are rows keyed by their Harness² label (`base1..k`, `inv1..k`,
`dom1..k`, `agg1..k` / `c1..k`, `select`, `reflect`); a step that succeeded is never run
again, and a step left `running` by a dead driver is re-run as a new attempt only when the run
is resumed. At boot, runs whose lease lapsed become `interrupted`; nothing is re-spent
silently. An infrastructure failure (timeout, outage, rate limit) retries a rollout once and
then fails the run, because it is not evidence about the harness.

### Spend is folded from the usage ledger

The run never accumulates spend in memory. Before every step the ledger is folded again from
the run's `harness-evolution` usage rows, and the step is refused when the worst observed
cost of its kind, or the pre-start estimate before any observation, would cross a ceiling.
The run then ends `budget_exceeded` with the base kept, except at a sequential round
boundary, where it selects among the rounds it finished. A step whose provider reports no
price marks the ledger's cost as a lower bound, and the token and call ceilings hold instead.
`maxBudgetUsd` is enforced by the Claude Agent SDK lane; on other lanes it is advisory, and
the rollout's evidence carries a caveat saying so.

### Selection ranks evidence before judgement

Each rollout gets a deterministic standing (no error, delivered, fewer failed checks, more
passed checks, fewer tool failures). A candidate counts at its worst replicate; the base at
its best and worst. A candidate below the base's worst is a regression and is out; a single
final that dominates the base is chosen without a judge. Otherwise the contenders, the base
among them, go to a blind judge under seeded anonymous ids. A judge failure, low confidence or
a verdict for the base keeps the base. This reverses the Harness² failure where a judge
preferred a 55-point run over a 95-point one.

### Rollout reuse

A rollout's cache key covers the harness content hash, the task input hash (prompt, input-file
hashes, frozen git base, checks), an environment fingerprint (app version, runtime, executor
model, isolation, turn ceiling, probe policy, tool-rule engine version) and the replicate
index. A hit is refused when the rollout failed for infrastructure reasons or was cancelled,
when it is older than seven days, when a library skill it carries drifted, or when it read
from outside the machine: evidence records every web-reader or third-party MCP tool call
(`externalReads`), and such a rollout is one sample of a moving world rather than a
repeatable experiment.

### Experience retrieval

Retrieval filters entries by visibility (agent, workspace, global) and domain, ranks them by
BM25 (the `@cognia/rag` index) over situation, lesson, conditions and tags plus structured
matches, and penalises entries from another runtime fingerprint. An entry becomes `verified`
when the adopted harness carried an edit the reflection found helpful, or when a later run
that was given it reports help with no harm; repeated harm rejects it. Each agent's library
is capped (`experienceCapPerAgent`, default 200) and evicts by utility.

### Adopted tool rules hold in live conversations

Probes apply a candidate's tool rules themselves. After adoption the same pure projection
runs on the `tool.result.project` interceptor point (ADR-0189), which interactive chat,
headless captures and scheduled runs all dispatch. The interceptor is registered only while
some agent has adopted rules, because a registration makes every turn pay the tool-result
review round-trip; probe sessions are excluded so rules are not applied twice. Call caps count
per turn.

### Triggers

- `manual`: the agent's **Evolve** page starts a run from a form showing the ADR-0232
  estimate and which ceilings it would cross.
- `failure-triggered`: a turn that fails with a harness-shaped diagnostic
  (`budgetExhausted`, `deadlineExceeded`, `contextWindowExceeded`, `dispatchRejectedCycle`,
  `dispatchRejectedDepth`, `dispatchRejectedPolicy`) shows an offer under the error, with the
  task pre-filled from the last user request. Offers respect a cooldown and per-agent
  dismissal, and are not repeated while a run for that agent is unfinished. Provider outages
  and permission denials are not harness failures and never offer.
- `background`: the same failures queue a run instead. An hourly scheduler maintenance task
  (`harness-evolution-sweep`) launches queued runs with at most `backgroundMaxRunsPerSweep`
  in flight and none sooner than `backgroundIntervalHours` after the previous start, so a
  day spends at most (24 / interval) × runs-per-sweep × the run budget. Queued runs older than
  a week are cancelled.

### Restoring an earlier version

Version history lists every snapshot of an agent (captures, candidates, compositions,
adoptions, restores). Restoring one creates a new `restored` snapshot whose parent is the
current harness and writes it through the same `agent-harness` configuration apply, so a
restore is itself undoable; it is rated with the adoption risk rules, recorded in the
governance ledger, and refused when the agent's harness changed after the person reviewed the
diff. Model, permissions and tools stay as they are.

### Surfaces

The agent detail page gains an **Evolve** mode (runs, experience library, version history), a
run opens at `/agents/evolution?run=<id>` with a timeline, live budget meters, candidate
comparison, the decision and the reflection, and Settings gains a Harness Evolution section
(feature switch, start mode, defaults, budget, role models, probe-safe MCP servers, background
pacing, library cap).

### Benchmark

`lib/harness/benchmark.ts` drives the real driver, store, checks, ledger, reuse and selection
with simulated rollouts, editors and judges over eight scenarios with known right answers
(clear improvement, harmful edit, misleading judge, uncertain tie, flaky executor, two-round
sequential fix, budget stop, outage retry) and reports decision accuracy, false adoptions,
missed improvements, budget violations and the R = 4k / P = 3k accounting. It costs nothing
and needs no provider; it does not measure how good real editors are.

## Consequences

- Probes reuse the chat resolver's clamps (tool filter, Restricted Mode, parent ceiling,
  finalizer); a candidate can never run with more capability than the agent.
- Agents gain visible harness sections in their profile; evolved variants show exactly which
  fields an adoption owns.
- Evidence and snapshots take local storage; trajectory text is capped, each agent keeps its
  newest 100 finished runs plus every run whose adoption is still in effect, and snapshots
  nothing references are pruned with them.
- Selection often keeps the base. That is the intended outcome when the evidence does not
  support a change.
- Rollouts that read MCP servers or web tools are never reused, and tasks needing external
  side effects cannot be probed unless the user allow-lists a read-only server.
- Shell commands a probe's policy lets through run on this machine. A scratch directory or
  worktree is not a sandbox; unless the agent runs in a sandbox runtime, every rollout's
  evidence says so.
- Adopted tool-result rules are not enforced on the Claude Agent SDK lane, and a call cap on an
  auto-allowed tool is applied after the call has run.
- External runtimes (Codex, Claude Code and other ADR-0217 agents) cannot be evolved; their
  harness is not Cognia's to edit.
- Runs, snapshots and experiences are device-local and do not sync.
