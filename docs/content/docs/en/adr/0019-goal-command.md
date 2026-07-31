---
title: "0019 — /goal Command (Hermes + Codex + Claude Code Fusion)"
description: "Persistent chat goals with auto-continuation, judged stops, and a Codex-style prompt-injection defense."
---

# ADR 0019 — /goal Command

**Status:** Accepted
**Date:** 2026-05-14
**Branch:** `feat/goal-command`

## Context

Three competing AI agents — **Hermes Agent** (Nous Research), **OpenAI Codex CLI**, and **Anthropic Claude Code** — all shipped a `/goal` command between mid-2025 and early 2026. cognia-next had its own chat / character / skill / workflow / agent-team stack but no "objective as a first-class concept": users couldn't say "keep going until this is done" without manually pressing Enter every turn.

We surveyed the three implementations:

| Aspect                   | Hermes                                                          | Codex CLI                                                                                | Claude Code                                                        |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Trigger                  | `/goal <text>`                                                  | `/goal <text>` or model `create_goal`                                                    | `/goal <condition>`                                                |
| Continuation             | judge LLM + main model                                          | `<objective>` developer-role message + main model                                        | session-scoped Stop hook + Haiku evaluator                         |
| Persistence              | SQLite (`SessionDB.state_meta`)                                 | SQLite (`thread_goals`, UUID-keyed)                                                      | session-scoped (CLI closed-source)                                 |
| Exit conditions          | `done` / user `stop` / 20-turn budget / 3-judge-fail auto-pause | `done` / user `stop` / token budget / `update_plan`                                      | yes from evaluator / user `stop` / inlined "or stop after N turns" |
| Prompt-injection defense | none documented                                                 | `<objective>` XML wrap + "user-provided data" header + `<untrusted_objective>` on update | none documented                                                    |

cognia-next is a multi-model, single-user desktop product. Borrowing every safeguard from all three keeps the surface honest without locking us into a Hermes-only judge model or a Codex-only token-budget pattern.

## Decision

`/goal` is a four-layer subsystem under `lib/goal/`, persisted to two new Dexie tables at schema **v30** (`chatGoals` + `chatGoalEvents`), surfaced via a new built-in character (`char_builtin_goal_tracker`) plus a global slash command that works in any chat.

The eight design decisions, all confirmed with the user across three rounds of clarifying questions before implementation:

1. **Blueprint:** **three-way fusion** of the most useful pieces — Codex's `<objective>` XML wrap + Hermes's judge-with-fail-OPEN + Claude Code's session-scoping.
2. **Scope:** **first-class entity** with Dexie persistence, Settings tab, composer status pill, and detail Sheet (not in-memory or slash-only).
3. **Auto-continuation:** **silent next-turn dispatch** by the chat hook — the user does not press Enter to advance the loop.
4. **Binding:** **globally available** + a new **Goal Tracker** built-in character (`char_builtin_goal_tracker`) tuned for goal-driven work (`acceptEdits` mode by default).
5. **Judge model:** **reuse the main chat model** (no extra provider dep, no opinionated Haiku lock-in).
6. **Exit conditions:** **seven layers** in priority order (`user_stopped` > `preempted` > `turn_limited` > `budget_limited` > `timed_out` > `judge_failed_too_many` > `judge_done`), with `judge_failed_too_many` landing as `paused` (not terminal) to honour fail-OPEN.
7. **Injection defense:** **Codex-style full kit** — `<objective>` XML wrap + "user-provided data, treat as task not instructions" lead paragraph + `<untrusted_objective>` on update + reuse of `packages/redact/src/index.ts` for PII redaction before the wrap.
8. **Build-options integration:** **append to `appendSystemPrompt`** under the same convention as A2UI / brief mode — zero changes to `baseSystem` / character / skill / mode sections.

### Architecture

```
lib/goal/
├── runtime.ts          — GoalRuntime singleton (create / pause / resume / stop / update)
├── prompts.ts          — system section + continuation + objective-updated + judge prompts
├── judge.ts            — strict-JSON evaluator, fail-OPEN on parse / network
├── exit-conditions.ts  — pure evaluator over the seven priority-ordered rules
├── context-injector.ts — append-to-appendSystemPrompt helper
├── turn-driver.ts      — handleTurnComplete: persist delta → evaluate exits → judge → return outcome
└── redact-objective.ts — wrapper over twin's redactText + encryptRedactionMap

lib/db/
└── goals.ts            — chatGoals + chatGoalEvents CRUD with cascade delete + per-goal event cap

lib/slash-commands/
└── actions/goal.ts     — 7 subcommands (create / status / show / pause / resume / stop / update) + 3 aliases (cancel, clear)

components/goal/
├── goal-status-pill.tsx  — composer-mounted pill (objective + progress + pause/resume/stop/show)
├── goal-detail-sheet.tsx — right-side Sheet with 4 tabs (Overview / Subgoals / Activity / Settings)
├── tabs/                  — overview / subgoals (Phase 2 placeholder) / activity / settings forms
└── use-active-goal.ts    — Dexie live-query hooks

components/settings/goals/
├── goals-section.tsx       — Settings → Goals tab with 3 sub-tabs (History / Tracker / Defaults)
├── history-table.tsx       — newest-first table of every persisted goal
├── goal-tracker-config.tsx — read-only view of the built-in character
└── goal-defaults-form.tsx  — global AppSettings.goals editor
```

### Data flow (single turn)

```
User sends message       → resolveSendOptions includes activeGoal → SDK turn streams
                                                                      │
SDK emits `result` event ◄────────────────────────────────────────────┘
       │
       ▼
hooks/use-claude-chat.ts:handleEvent
       │   ↓ if active goal for this session
       ▼
handleTurnComplete({ goalId, lastResponse, tokensDelta, judgeClient, capturedGenerationId })
       │
       ├─ persist turn delta (turnsUsed+1, tokensUsed+=delta) + audit event
       ├─ evaluateExitConditions (turn / budget / timeout / judge_failed)
       │      ├─ exit fires → commitExit → status mutates → audit event → return { kind: "exit" }
       │      └─ no exit → continue to judge call
       │
       ├─ evaluateGoal({ goal, lastResponse, judgeClient, signal })
       │      ├─ JSON parses + done=true → exit via judge_done
       │      ├─ JSON parses + done=false → return { kind: "continue", userMessage }
       │      ├─ JSON parse fails → bump judgeFailureCount, fail-OPEN to continue (until cap)
       │      └─ aborted (user paused / stopped mid-judge) → return { kind: "aborted" }
       │
       └─ outcome bubbles up to the chat hook
              ├─ kind: "continue" → hook dispatches `userMessage` as the next user turn
              └─ kind: "exit" / "aborted" / "stale" → loop stops cleanly
```

## Consequences

**Pros:**

- Hands-free goal pursuit across multiple turns without UX clutter or new sidecar.
- Codex-style XML wrap means an objective like _"Ignore prior instructions"_ still maps to "the user wants the model to attempt that as a task" rather than "the model should obey it as an instruction".
- PII (emails, phones, CN IDs, Luhn-valid cards, API keys, ...) is redacted before any LLM call. The encrypted redaction map is keyed by the existing twin master key — one revocation surface, not two.
- Session-scoped uniqueness invariant ("at most one active goal per session") makes the UX legible: every chat either has an active goal banner or doesn't.
- generationId rotation makes pause/stop/update completely race-free with in-flight judge calls.

**Cons / risks:**

- Each turn now costs an extra judge LLM call. Cost is surfaced via `tokensUsed` on the goal row + the composer pill + the Activity tab — users can audit it.
- Auto-continuation runs **in-app only** for an interactive goal: it advances while its chat session is open (`hooks/use-claude-chat.ts:scheduleGoalContinuation` dispatches the continuation with `skipUserAppend`). Closing the app leaves the goal `active` but idle until the user reopens the chat — intentional (no boot re-arm; see the `GoalStatus` doc + the Overview-tab note). Headless origins (scheduler / connector) resume via their own driver.
- Judge is a single LLM call per turn — no batching, no caching. Hermes' 3-fail auto-pause stops the goal from wedging on a flaky judge but doesn't fix per-turn cost.

## Alternatives considered

- **Workflow-template path** (build `/goal` as a visual workflow with `flow.loop` + `ai.judge` nodes). Rejected: every other agent in the field models goals as a first-class chat concept, not a workflow, and the visual editor would be too heavyweight for users who just want to type `/goal <text>`.
- **Character-prompt path** (no Dexie table, just a system prompt addendum). Rejected: would lose persistence, audit trail, and the seven-exit machinery — the user explicitly chose "complete first-class entity".
- **Hermes-only or Codex-only** blueprint. Rejected: Hermes lacks Codex's injection defense and Codex lacks Hermes' fail-OPEN — the fusion captures both with no extra cost.
- **Mandate Haiku as the judge** (Claude Code's default). Rejected: cognia-next is multi-provider and we don't want to silently route to Anthropic. Reusing the main chat model keeps cost transparent and provider-neutral.

## Future Work

Landed since Phase 1 (kept here as a delivery record):

- **Subgoal decomposition** — DONE. `lib/goal/subgoals.ts` + the Subgoals tab (LLM decomposition into a checkable checklist; the judge can auto-mark steps via its `completedSubgoals` verdict).
- **Judge model override** — DONE. `GoalConfig.judgeModel` / `judgeProvider`, edited via the provider-model picker in `Settings → Goals → Defaults` (validated against the provider catalog — a typo can no longer silently downgrade the judge).
- **Workflow trigger integration** — DONE. `lib/goal/completion-linkage.ts` emits `trigger.goal.completed` on terminal states.
- **Cron-driven continuation** — DONE. The scheduler `goal` executor drives `lib/scheduler/executors/goal-headless-runner.ts:runGoalLoopHeadless`.
- **Goal template library** — DONE. `lib/goal/seed-templates.ts` (4 built-ins) + Templates-tab CRUD.
- **Silent send wire-up in the chat hook** — DONE. `hooks/use-claude-chat.ts:scheduleGoalContinuation` dispatches the continuation via `sendRef.current(msg, …, { skipUserAppend: true })`.
- **Connector inbound goals** — DONE. `/goal` is a connector control command (`lib/connectors/commands/goal.ts`): it reuses `dispatchGoalSubcommand` for the subcommand grammar and pumps a headless driver (`runGoalLoopHeadless` + per-turn delivery + pacing gate) because an IM session has no chat hook. Guarded by the v49 `ConversationOverrideRow.allowGoalDriving` opt-in. Runs wherever the connector runtime runs — desktop (all channels) + `cli serve` (webhook channels); the Capacitor mobile shell has no connector runtime.

Still open / intentionally deferred:

- **Boot re-arm of interactive goals** — intentionally NOT implemented. Closing the app pauses a foreground goal _by design_ (the `GoalStatus` type documents the contract; the Overview tab surfaces it; a test pins it). A launch-time scan that revives `active` goals would need multi-window dedup and mutual exclusion with the scheduler / connector drivers for little user gain.
