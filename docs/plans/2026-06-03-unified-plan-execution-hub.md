# Implementation Plan — Unified Plan Execution Hub (ADR-0045)

Branch: TBD (`feat/unified-plan-execution-hub` off `master`).
Each phase must ship green before the next: `pnpm typecheck`, `pnpm test:coverage` (≥90% lines/branches/functions on new files), `pnpm lint:i18n`, and `pnpm sidecar:test` for any phase that touches `sidecar/`.

All new types live under `types/`. No hard-coded user-facing strings (next-intl keys in both `en.json` and `zh-CN.json`). Co-located `*.test.ts(x)` for every new `lib/**`, `hooks/**`, `components/**` (excluding `components/ui/`).

---

## P1 — Model + persistence

Goal: a structured, persisted `AgentPlan` with a lifecycle, injectable into sends. No execution yet.

- **`types/agent/plan.ts`** (rewrite of dead `types/agent/agent.ts`): `PlanStepKind`, `PlanStepStatus`, `PlanStep`, `PlanStepParams` (kind-tagged union), `AgentPlan`, `PlanConfig`, `PlanEvent`, `PlanRefinementRequest/Result`, `CreatePlanInput`, `UpdatePlanInput`, `PLAN_REFINEMENT_PROMPTS` (ported + `repair` added).
- **Delete `types/agent/agent.ts`**; update the (currently zero) importers — confirm `tsc` stays green. Remove the deprecated `onAgentPlanCreate`/`onAgentPlanStepComplete` references only if orphaned by the rename (they live in `DEPRECATED_HOOK_POINTS`; leave untouched otherwise — pre-existing, out of scope).
- **`lib/db/schema.ts`**: Dexie **v71** (additive, no upgrade hook) — `agentPlans: "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt"`, `agentPlanEvents: "&id, planId, [planId+ts], kind, ts"`. Table fields on the class, mirroring `chatGoals`/`chatGoalEvents` (`schema.ts:243`, `:1092`).
- **`lib/db/plans.ts`**: CRUD enforcing one active (`executing`/`awaiting_approval`/`approved`) plan per `sessionId`; append-only `appendPlanEvent` capped at N newest per plan. Mirrors `lib/db/goals.ts`.
- **`lib/agent/plan/runtime.ts`**: `createPlan`, `approvePlan`, `rejectPlan`, `pausePlan`, `resumePlan`, `cancelPlan`, `registerAbortController`, `updateObjective`-equivalent — lifecycle + `generationId` staleness guard + AbortController fan-out, mirroring `lib/goal/runtime.ts`. (Execution call-out is a stub returning early in P1.)
- **`lib/agent/plan/prompts.ts`** + **`context-injector.ts`**: `renderPlanSystemSection(plan)` and `appendPlanContext(opts)` mirroring `lib/goal/prompts.ts` + `lib/goal/context-injector.ts`.
- **`lib/agent/plan/pii-gate.ts`**: redact plan text via `hasNoLeakingPii`.
- **`lib/claude/types.ts`**: `SendOptions` / session `activePlan` field. **`lib/claude/build-options.ts`**: invoke `appendPlanContext` next to the goal block (`~1239`); `session.activePlan` precedence.
- Tests: db invariant, runtime lifecycle + generationId guard, context-injector, pii-gate, build-options plan injection.

Verify: `pnpm typecheck && pnpm test:coverage && pnpm lint:i18n`.

## P2 — Execution engine

Goal: an approved plan actually runs, strategy chosen by shape.

- **`lib/agent/plan/synthesize-workflow.ts`**: `synthesizePlanWorkflow(plan)` — pure, Kahn cycle check, `__plan__:<planId>:<nonce>` id, nodes `action.plan.step.dispatch`. Mirrors `synthesize-workflow.ts` (team).
- **`lib/workflow/nodes/built-ins.ts`** + `catalog.ts` + `params-schemas.ts`: register `action.plan.step.dispatch`; executor routes by `step.kind` (`agent_turn` / `tool_call` / `sub_workflow` / `approval_gate`; `teammate_dispatch` lands in P3). Plan-run context registered in a WeakMap, mirroring `team-run-context.ts`.
- **`lib/agent/plan/in-session-driver.ts`**: linear all-`agent_turn` driver mirroring `lib/goal/turn-driver.ts` — drives the visible session turn by turn, persists step deltas, honors AbortController + generationId.
- **`lib/agent/plan/runtime.ts`**: `runPlan` chooses in-session vs `runWorkflow(synthesizePlanWorkflow(plan))` from `executionMode: "auto"` shape analysis. Persist `PlanEvent`s; notify via `notify()`.
- Tests: synthesize (cycle/empty/dep validation), node executor per kind, in-session driver, hybrid selection.

Verify gates.

## P3 — Chat → orchestration

Goal: chat agent authors plans and orchestrates directly.

- **`teammate_dispatch`** kind in `action.plan.step.dispatch` → `dispatchTeammate` (reuse `lib/ai/agent/team/dispatch-teammate.ts`); plan-run context provides the teammate pool, reusing `runTeamLifecycle` allocation where a team is bound.
- **ExitPlanMode capture**: in `hooks/chat/use-claude-chat.ts`, beside `applyPlanModeBridge`, build `AgentPlan(draft, source="exit_plan_mode")` and surface for approval.
- **`sidecar/plan-tools/tool-defs.mjs`**: `CreatePlan` / `UpdatePlan` single-source defs (names/desc/schemas) mirroring `sidecar/a2ui-tools/tool-defs.mjs`; register in both stdio + SDK servers; renderer-side dispatch (sidecar can't import `lib/`) into plan runtime. Jest parity test importing the `.mjs` as a drift guard (mirror the a2ui parity test).
- Tests: teammate_dispatch routing, ExitPlanMode→plan capture, tool def parity + renderer dispatch.

Verify gates incl. `pnpm sidecar:test`.

## P4 — Goal / Team projection

Goal: the two existing mechanisms feed the one pipeline.

- **`lib/agent/plan/projections.ts`**: `planFromTeam(team, tasks)` ⇄ `tasksFromPlan`, `planFromGoal(goal)`; preserve DAG + dependencies.
- Route `GoalSubgoal` decomposition and `AgentTeamTask` DAGs through the plan tracker so they share status/persistence/UI. Keep existing Goal/Team behavior as the default; projection is opt-in at their seams.
- Tests: round-trip projection fidelity, dependency preservation.

Verify gates.

## P5 — Planner + replan + UI

Goal: author-from-objective, the three replan triggers, and surfaces.

- **`lib/agent/plan/planner.ts`**: `decomposeIntoPlan(objective, deps)` reusing `LlmClient` + `extractJson` (mirror `lib/goal/subgoals.ts`).
- **Replan**: `refinePlan(request)` wired to (a) step-failure auto (capped by `maxAutoRefinements`), (b) manual UI, (c) `judgeDeviation` between-steps judge reusing `lib/goal/judge.ts` pattern.
- **UI** (`components/agent/plan/*`): `plan-approval-card.tsx` (inline review/edit/approve/reject/refine), `plan-tracker-panel.tsx` (live step DAG in the agent workspace, reusing the `PlanModeTasksSheet` host), refinement controls. i18n both locales.
- Tests: planner decomposition (mocked LlmClient), each replan trigger, RTL for card + panel (query by role).

Verify gates + a Playwright smoke of the approve→execute path (or note "UI not verifiable from here").

---

### Cross-phase invariants

- Types in `types/`. No simplifications / stubs in production paths.
- Reuse, don't reinvent: `dispatchTeammate`, `runWorkflow`, `approval-bus`, `notify`, `hasNoLeakingPii`, `LlmClient`, `appendSystemPrompt` convention.
- A zh ADR mirror (`docs/content/docs/zh/adr/0045-…`) and the bilingual subsystem docs follow once the model stabilizes (post-P2).
