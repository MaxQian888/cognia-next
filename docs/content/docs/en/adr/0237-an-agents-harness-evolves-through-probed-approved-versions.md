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
at a frozen git base). Every ask-tier permission request is denied and recorded. The
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

## Consequences

- Probes reuse the chat resolver's clamps (tool filter, Restricted Mode, parent ceiling,
  finalizer); a candidate can never run with more capability than the agent.
- Agents gain visible harness sections in their profile; evolved variants show exactly which
  fields an adoption owns.
- Evidence and snapshots take local storage; trajectory text is capped and runs follow a
  retention period.
- Selection often keeps the base. That is the intended outcome when the evidence does not
  support a change.
- Rollouts that touch MCP servers or web tools are never cached, and tasks needing external
  side effects cannot be probed unless the user allow-lists a read-only server.
