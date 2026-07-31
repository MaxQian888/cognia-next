---
title: 0070 — Risk→Ceremony Policy Layer
description: A deterministic risk classifier that decides when an autonomous run owes a human a checkpoint, wired first into Agent Team's plan-approval gate.
---

## Status

Accepted. Phase 1 (Agent Team) implemented 2026-07-15. Phases 2–3 planned; this
ADR is the single home for all three — each phase appends its own section rather
than opening a new ADR.

## Roadmap

| Phase | Surface         | Raises (existing gate)                       | Invasiveness             | Status  |
| ----- | --------------- | -------------------------------------------- | ------------------------ | ------- |
| 1     | Agent Team      | `requirePlanApproval`                        | low (one wiring point)   | done    |
| 2     | /goal           | `requireAcceptance` (+ `manualContinue`)     | low                      | planned |
| 3     | Visual Workflow | auto-inserted `approval` wait per risky node | high (per-node path)     | planned |

The thesis is the same at every phase: classify deterministically, then
**auto-raise the checkpoint the surface already has**. No phase invents a new
gate mechanism, and low-risk runs are never touched.

`ceremony.ts` therefore defines its full shape up front (`gate`,
`requirePlanApproval`, `requireAcceptance`, `manualContinue`) even though Phase 1
reads only `requirePlanApproval` — so Phase 2 wires in without churning the
interface or re-testing the map. `manualContinue` is **interactive-only** by
construction: a headless goal that holds every turn never advances, so the
consumer (not this map, which cannot see the origin) must suppress it headless.

## Context

cognia-next's autonomous surfaces (`/goal`, Agent Team, Visual Workflows) each
have strong human-checkpoint **mechanisms** but no **policy** deciding *when* a
checkpoint must fire based on what a run will actually do.

Concretely for Agent Team: the strongest gate, `requirePlanApproval`, defaults
**off** (`DEFAULT_TEAM_CONFIG`) and nothing raises it automatically. A team run
whose roster can drive the mouse, shell out to the OS, or delete data received
exactly the same **zero-gate** treatment as a run that summarizes a document.
The gate existed; nothing decided when to use it.

## Decision

Introduce `lib/policy/risk/` — a cross-cutting, surface-agnostic policy layer:

| Module             | Responsibility                                              |
| ------------------ | ----------------------------------------------------------- |
| `risk-surfaces.ts` | Exhaustive taxonomy of risk surfaces + severity + i18n key   |
| `classify-risk.ts` | Pure `RiskInput → RiskAssessment` (tier, surfaces, reason)   |
| `ceremony.ts`      | `RiskAssessment → RequiredCeremony` (what a human is owed)   |

Its first consumer is Agent Team, via the adapter
`lib/ai/agent/team/risk-input.ts` (`AgentTeam` + roster → `RiskInput`). Before a
run starts, `agent-team-runtime.ts` classifies it and ORs the resulting ceremony
into the existing plan-approval gate:

```ts
const riskAssessment = classifyRisk(buildTeamRiskInput({ team, workers, tasks }))
const riskRaisedGate =
  (team.config.riskGating ?? true) && requiredCeremony(riskAssessment).requirePlanApproval
const requirePlanApproval = Boolean(team.config.requirePlanApproval) || riskRaisedGate
```

The gate is only ever **raised**, never lowered: an operator-set
`requirePlanApproval` survives a `low` assessment untouched.

### Risk surfaces

| Surface            | Severity   | Primary signal                                   |
| ------------------ | ---------- | ------------------------------------------------ |
| `external-send`    | high       | An agent-callable send tool/capability id        |
| `computer-use`     | high       | A computer-use tool id                           |
| `native-command`   | high       | A Bash/shell tool id (→ elevated when sandboxed) |
| `data-destructive` | high       | A delete tool id, or a destructive verb in text  |
| `credential-auth`  | elevated   | A keyring/secret/auth id, or a credential term   |
| `file-write-broad` | elevated   | A Write/Edit tool id **and** no sandbox          |

Tier = max severity across hits (`elevated` → medium, `high` → high, none →
low). Phase 1's ceremony maps medium and high identically (`requirePlanApproval`);
the distinction is carried for later phases and for the operator-facing reason.

### Deterministic only

No LLM call. A safety gate must not depend on a model's mood, and a classifier
that can be prompt-injected by the very objective it is judging is worse than no
classifier. LLM augmentation is a later phase and must never become the sole
judge of a gate.

### Gate on positive evidence, not on uncertainty

The default tier is `low` (proceed) unless a known-dangerous capability or a
destructive-intent signal is **positively detected**. This deliberately diverges
from a "gate-unless-proven-safe" default.

The justification is product UX, and it is load-bearing: this is an end-user
product, not a CI bot. A gate that fires on every unrecognized tool id trains
operators to click through it — or to disable `riskGating` wholesale — at which
point it protects nobody. **Unknown ≠ risky.** The cost of this choice is that a
genuinely dangerous *new* tool is unclassified until someone adds it to the
taxonomy; the exhaustive `Record` in `risk-surfaces.ts` makes adding a surface a
compile-time obligation, and the fixture table in `classify-risk.test.ts` pins
every rule.

Tool/capability **presence** is the primary signal; keyword sets are a coarse
secondary one, used only for intent no tool id can express (destroying data,
handling credentials). Keyword sets are kept small and high-precision — `clear`
and `remove` are excluded because "clear up the docs" is ordinary work, and a
false gate is a real cost.

## Behavior change (intended, fail-closed)

`gate-policy.ts` maps plan-approval on a **headless** origin (scheduler / IM /
bridge / plugin / team→team) to `fail-fast`. With `riskGating` defaulting true, a
headless team run whose roster is medium/high risk now **refuses** instead of
running unattended, and the failure reason names the surfaces:

> This run touches `high — computer-use` and cannot proceed unattended
> (origin=scheduler); run it interactively, or set riskGating=false to opt out.

This is the point of the ADR, not a side effect. `AgentTeamConfig.riskGating`
(default `true`) is the operator opt-out that restores the previous behavior.

When the gate is risk-raised **and** the operator had also set
`requirePlanApproval`, the operator's choice is named as the cause — telling
them it was the risk assessment would be a lie.

## Rejected: treating connector binding as `external-send`

The Phase 1 plan proposed `connectorBound === true` (an IM-triggered run) as a
standalone `external-send`/high signal. **Rejected**, because it would have
silently disabled a shipped feature: `startTeamRunFromIM`
(`lib/connectors/team-dispatch.ts`, reached from `lib/connectors/runtime.ts` and
the `im/dispatch-task` skill) is a headless `origin: "im"` flow, so *every*
IM-bound team run would have failed-fast by default. A user @-mentioning a bound
team in Feishu would get a refusal instead of an answer.

It is also the wrong model. A team summoned from a thread replying **into that
same thread** is the feature working: the recipient is the person who asked, and
they are watching. The real `external-send` risk is reaching a recipient the
requester did not ask for, which requires an agent-callable send tool — that is
what the classifier matches. And the fallout would have been worse than the gap:
operators would blanket-disable `riskGating` to get their IM teams back, losing
the computer-use/shell gating that is the actual value.

The classifier is therefore **origin-blind** — it judges what a roster can
*reach*, never where the run came from. An IM-bound run with a computer-use
teammate still gates (and, headless, still refuses); a plain one does not.
Pinned by `classify-risk.test.ts` ("is origin-blind") and two runtime tests.

## Phase 2 — /goal

At creation, `GoalRuntime.createGoal` classifies the goal and merges the owed
ceremony into its config: medium → `requireAcceptance` (completion parks at
`awaitingAcceptance` for sign-off); high → also `manualContinue`. The existing
acceptance machinery (`turn-driver.ts` → `acceptance.ts`) needed no change — it
already keys off `config.requireAcceptance`. The assessment is recorded on the
`goal_created` event and rendered in the Activity tab from the **localized**
surface labels (the classifier's `reason` is English-only diagnostic text).

Two invariants:

- **Raise only.** Every merge is `configured || raised`, so a flag the user set
  survives a `low` assessment. The policy adds ceremony; it never removes any.
- **`manualContinue` is interactive-only.** A headless goal holding every turn
  for a human who isn't there is a hang, not a gate. `createGoal` therefore takes
  a `GoalRunOrigin`; the five headless callers (scheduler, plugin API, remote
  control, workflow node, companion write-source) pass theirs, and the
  suppression lives in the consumer because the ceremony map cannot see origin.

**Honest limitation.** A goal has no roster, so the only creation-time signals
are the redacted objective and the session's *configured* posture — weaker than
Phase 1's. Evidence is drawn from explicit configuration only (allow-listed
tools, `enableComputerUse`, operator-enabled builtin suites). It deliberately
does NOT infer "the Anthropic SDK ships a native Bash, therefore every goal can
shell out": true, but useless — it would gate every default goal and teach
operators to switch `riskGating` off. SDK-native tools remain covered by the
per-call permission gate. The real fix is per-turn tool-call interception, which
is out of scope here.

**Behavior change:** a risky headless goal (scheduler) now parks at
`awaitingAcceptance` instead of auto-completing. Opt out with
`GoalConfig.riskGating: false` (or the `GoalDefaults.riskGating` app default).

**Incidental fix.** `resolveGoalConfig` never passed `requireAcceptance` through,
so `createGoal({ config: { requireAcceptance: true } })` silently dropped it —
the flag was only reachable post-hoc via the settings tab. The raise-only
guarantee depends on reading the caller's own choice, so the passthrough was
added here.

## Phase 3 — Visual Workflow

A workflow is a DAG whose nodes each do one concrete thing, so the node **kind is
the evidence** — stronger than a roster or an objective.
`action.desktop.performAction` does not merely have access to the machine; it
executes a revision-bound UI mutation. `node-risk.ts` therefore maps kinds to
surfaces directly (`RISKY_NODE_KINDS`, exhaustive
`Record`) and reuses only the severity table, so a node's tier and a roster's
tier still mean the same thing.

`risk-gate.ts` runs before each step in the orchestrator and **invents no new
gate**: it reuses `action.approval.request`'s own machinery
(`registerPendingApproval` + a `step.long_running.checkpoint` + `subscribeWake`),
so an auto-gate resumes after a crash exactly like an authored approval node and
the same pending-approval UI answers it. Three rules: de-dup when an approval
node is a transitive ancestor (`ancestorsOf`, reused from `run-single-node.ts`);
fail closed on a headless trigger; never touch a low-risk node.

### Taxonomy judgment calls

The absences are the design. Gated: connector send/forward, git push, mobile
share (leave the machine, cannot be unsent); every `action.desktop.*` that acts
or captures; real-shell nodes; connector delete. **Not** gated: `.draft` and
`.reaction` (trivially reversible); local git commit/stage/branch; deletes of
app-local records (`action.goal.delete`, `action.plan.delete`,
`action.scheduler.task.delete`) — a workflow tidying up its own goals is routine
automation, and gating it teaches operators to switch `riskGating` off, losing
the shell/mouse/send gating that is the point; and `action.plugin.invoke` /
`action.skill.invoke` — wildcards, but a rule that gates every plugin call gates
most real workflows, and they stay covered by the per-capability plugin
permission guard. The layer gates what escapes the app or cannot be undone, not
every mutation.

### Migration — decision #2 ("B"), and why it is not hypothetical

`VisualWorkflow.riskGating` is **opt-in**: `undefined` → OFF, inverting the
Team/goal default deliberately. A workflow authored before this ADR has no field;
turning gating on retroactively would start pausing (interactive) or failing
(headless) automations users already rely on. A survey of first-party workflow
definitions found exactly one risky node in shipped content —
`plugins/zhihu-content-pipeline/src/workflow/template.ts:59` uses a real
`action.system.terminal` — so migration "A" (global default true) would have
broken it. `lib/db/workflows.ts:createWorkflow` stamps `riskGating: true`, so new
work is gated and existing work is untouched.

### Two traps worth recording

1. **The zod schema is the engine's source of truth.** The orchestrator reads
   `validated`, not the caller's object, and `z.object` strips unknown keys — so
   `riskGating` was silently dropped and the gate was dead in the real run path
   while every unit test passed. It had to be declared in
   `lib/workflow/definition/validate.ts`. Caught only by an orchestrator-level
   integration test; this is the repo's classic built-but-dormant defect.
2. **Capability preflight (ADR-0060) runs first.** Desktop/terminal nodes are
   already preflight-failed off-desktop (`capability-missing:pty`), so they never
   reach the risk gate there. The gate matters on desktop; tests that need to
   exercise it off-desktop must use a kind with no capability requirement.

## Consequences

- Agent Team gains risk-triggered plan approval with no new friction on low-risk
  runs (the Quick lane is untouched — verified by a dedicated test).
- Headless risky runs fail closed, with a surface-named reason.
- `lib/policy/risk/` is transport-agnostic: `/goal` and Workflow wire in later
  phases by adding their own adapter, not by touching the classifier.
- `ceremony.ts` centralizes the tier→ceremony mapping so later phases add fields
  (`requireAcceptance`, `requireStepConfirm`) without touching consumers.

## Out of scope (later phases)

`/goal` and Workflow wiring; LLM-assisted classification; interaction with
per-tool `bypassPermissions`; a distinct "hard block even in bypass" ceremony; a
settings UI for `riskGating` (the config default suffices for Phase 1).
