# CONTEXT — Workflow Orchestration & Skills Convergence

Domain language and load-bearing decisions for turning the Visual Workflow engine
into cognia's **orchestration harness**, and for how **skills** relate to it.
Keep this glossary stable; flag any usage that conflicts with it. Scope is the
visual workflow subsystem (`lib/workflow/`, `components/workflow/`,
`types/workflow/visual.ts`, `src-tauri/src/workflow/`) and its seam with
`lib/skills/`. Companion ADRs: 0011 / 0017 / 0022 / 0034 / 0077.

> **Status note (2026-07):** the D3 / D5 / D6 build targets below have SHIPPED
> (structured output on `agent.turn` + `ai.prompt` v1/v2, `ai.ensemble` /
> `ai.council`, `data.aggregate`, publish + the shared typed runner
> `wf_run_workflow_typed`, the skills→tools projection, and the
> `trigger.workflow.completed` chain trigger). The Decision texts are kept for
> their rationale; where a "gap" is named, read it as the gap that MOTIVATED
> the decision, not the current state. See
> `docs/plans/2026-07-16-workflow-linkage-remediation.md` for what closed when.

> **Control-plane update (2026-08):** the taxonomy now contains 153 node kinds.
> Formal CLI, trigger, history, Dead Letter, MCP, and subworkflow entrypoints
> resolve an immutable production deployment through `execution-authority.ts`;
> only editor Preview/Test may call the draft orchestrator directly. Every run
> carries a root `traceId` plus explicit parent/retry lineage. Approval,
> risk-gate, and event waits share the v156 `workflowWaitpoints` /
> `workflowWaitEvents` repository (Dexie on web, mirrored in the Tauri workflow
> SQLite store), so the pending state and original deadline survive restarts.

## Glossary

### Orchestration harness

The visual workflow engine, used as the substrate that composes multiple bounded
AI/agent invocations. Imported deliberately from Claude Code's _Workflow tool_
philosophy (fan-out / pipeline / adversarial-verify / loop-until-dry). NOTE: the
repo had **no** prior "harness" concept — it must be introduced. The harness
_intent_ is sound; its _literal mechanism_ is not a 1:1 port (see Decisions).

### Harness unit _(the atomic composable step)_

The thing an orchestration composes = a **bounded agent invocation**:
`action.agent.turn` parameterized by prompt + (loaded) skills + tools + an
**output schema** that forces a validated, typed result. This is cognia's
equivalent of the harness `agent(prompt, { schema })`. SHIPPED: `agent.turn`
and `ai.prompt` (v1 AND v2) consume `outputSchema` / `onSchemaViolation`
through the shared `runStructuredTurn` contract (validate → one bounded
auto-fix retry → fail into errorPolicy, or soft-stamp `schemaValid:false`) —
see `lib/workflow/nodes/ai/structured-turn.ts`.

### Skill _(in this domain)_

A **capability/playbook** — flat markdown + `allowedTools` — that an agent loads
on demand. A skill **never executes** (`lib/skills/executor.ts` is a deliberate
stub; "there is no skill VM"). In a graph a skill is **loaded into** a harness
unit (via `skillIds` / the `action.skill.invoke` seam), it is **not itself a
node**. This mirrors the Agent SDK: skills are the _capability layer_, subagents
(harness units) are the _orchestration layer_ — two layers, never merged.

### Capability layer vs Orchestration layer _(load-bearing separation)_

- **Capability** = skills, tools, MCP — what a single agent can _do_.
- **Orchestration** = the DAG + harness units — how multiple invocations are
  _scheduled and composed_.
  Verified against n8n and Dify: both keep these strictly separate, and **neither**
  has a "skill that is a graph" type. The reusable unit is always tool /
  sub-workflow / agent.

### Published callable unit _(the convergence pattern)_

A finished workflow given a **declared interface** (typed input schema + typed
output schema) so it can be _called_ — by an agent as a tool, by another workflow
as a sub-step, and surfaced in the skill catalog as "an entry whose body is a
graph." Interface (schema) is declared **separately** from implementation (the
graph); callers see only the interface. This is exactly n8n `ToolWorkflow →
DynamicStructuredTool` and Dify's `WORKFLOW` provider type. This — not
"skill = node" — is what "工作流 skills / skills 工作流化" resolves to.

### Native control flow _(already exists — do not rebuild)_

Parallel/fan-out, pipeline, dynamic map (runtime-sized N), and
loop-until-condition + accumulator are **already** delivered by the DAG +
`flow.loop` v2 (`orchestrator.ts` ready-set scheduler; `loop-container.ts`
`while`/`iterationConcurrency`/`items[]`). The old 1-vs-4 `maxConcurrency`
default split is gone: `DEFAULT_MAX_CONCURRENCY` (4) is backfilled by the
settings zod schema, so legacy no-field workflows run at the same width as
new ones. Top-level back-edges are now REJECTED at validation (they never
re-executed — the only iterating construct is the `flow.loop` v2 container).

## Decisions

- **D1 — Spine: the workflow engine becomes the orchestration harness, in its
  _corrected_ form.** Adopt the harness _intent_, not a literal port of its code
  primitives.

- **D2 — Do NOT add parallel/pipeline/loop as new "node primitives."** They are
  redundant with native DAG + `flow.loop` v2. The only control-flow work is
  **concurrency ergonomics** (a sane `maxConcurrency` default + a visible
  "parallel" affordance), not new control nodes.

- **D3 — The keystone is structured output on the harness unit.** Give
  `action.agent.turn` (and `ai.prompt`) a validated output schema. Everything
  composable — verify, reduce-over-typed-data, publish-with-typed-interface —
  depends on this. Scope is **"expose + harden," not "build":** the capability
  already exists end-to-end as `executeAgent.outputFormat` (prompt-injected
  JSON instruction → `parseStructured` → `result.object`/`result.parseError`,
  `agent-executor.ts:135-142,207-210`) but is (a) not exposed on the node and
  (b) best-effort parse, unvalidated, no retry.
  - **Mechanism is forced, not chosen:** the sidecar (`query()`) returns text and
    cannot do provider-native structured output, so **prompt-injection is the only
    mechanism for any agentic turn.** Native `generateObject` stays an optional
    fast-path for single-shot non-agentic nodes only.
  - **Validation semantics (D3a):** parse → validate against JSON-Schema (reuse
    the sidecar's existing `jsonSchemaToZodShape`, `plugin-tools.mjs:164`) → on
    violation, **bounded auto-fix retry ×1** (re-prompt with error + schema) →
    still failing ⇒ **node hard-fails into the existing `errorPolicy`**
    (retry / error-branch / continue). Per-node `onSchemaViolation: "fail" |
"soft"` override, **default `fail`** — typed output is a real contract, not a
    hint. (n8n auto-fix parity; reuses the engine's error machinery, no new path.)
  - **Authoring UX (D3b, recommend-and-proceed):** schema stored as serializable
    **JSON Schema** (rides the workflow JSON), authored via a visual field builder
    (name/type/required/desc, reusing existing inspector form infra) + a raw
    JSON-Schema escape hatch + "infer from example" (n8n parity). Validated object
    surfaces as a typed tab in the NDV data inspector for downstream drag-to-map.

- **D4 — Skills stay capabilities, loaded into harness units; never nodes.**
  Honors the Agent SDK layer separation. Rejects literal "skill = executable
  node." `action.skill.invoke` (skill → prompt text) remains the load seam.

- **D5 — Convergence = publish a workflow as a callable unit** (typed
  tool / skill-catalog entry whose body is a graph), the n8n/Dify pattern —
  NOT compiling skill markdown into a graph, NOT a new skill VM.
  - **Interface (explicit):** declared by canvas `trigger.input` (input schema)
    - `output` (output schema) nodes — visible contract, drag-to-map, mirrors
      n8n's `ExecuteWorkflowTrigger` and the harness agent signature.
  - **Publishing registers 3 call surfaces:** ① the typed **agent tool** — ONE
    shared runner `wf_run_workflow_typed` (name → published workflow), NOT a
    per-workflow `wf_<slug>` tool; the slug in `published.toolName` is
    display-only (`lib/workflow/publish/runner-tool.ts` is the single source
    for the name + definition), ② a typed **`flow.subworkflow`** target (the
    inspector renders schema-driven typed input fields for published targets),
    ③ a **skill-catalog entry `kind:"workflow"`**.
  - **Graph-bodied skill behavior — SHIPPED:** `renderSkillsSection` /
    `renderSkillsCatalog` special-case `kind:"workflow"` (the canonical body /
    one-line contract both name the shared runner + the workflow name; stale
    stored bodies self-heal at render), and the skills→tools projection in
    `lib/claude/build-options.ts` guarantees the runner tool is in the session
    whenever a workflow skill is active — with an execution fallback in
    `lib/claude/plugin-tool-ipc.ts` for when the workflow-ai plugin is
    disabled. It is NOT injected as a prose playbook (that would lose
    deterministic execution — explicitly rejected).
  - **Chaining (ADR-0081):** `trigger.workflow.completed` fires a decoupled
    downstream workflow when a run reaches a terminal status — depth-capped
    (10) with self-trigger rejection; emitted by the orchestrator through
    `runtime/workflow-completion-fanout.ts`. `flow.subworkflow` remains the
    embedded (parent-owns-child) composition; the trigger is the decoupled one.

- **D6 — Genuine net-new build targets — ALL SHIPPED:** ① structured output
  (D3, keystone — `structured-turn.ts`) ② first-class ensemble / N-vote /
  adversarial-verify node (`ai.ensemble` + `ai.council`, `lib/workflow/nodes/ai/`)
  ③ real reduce/aggregate (`data.aggregate` with collect / concat / merge /
  group-by / dedupe / numeric / custom reducer; `flow.join` can apply it
  inline). `data.transform`'s `reduce` op remains a back-compat numeric sum —
  the inspector points users at `data.aggregate` for general folds.

- **D6② — Ensemble is ONE configurable first-class node.** Wraps a `target` =
  inline `agent.turn` config OR a referenced sub-workflow, runs it ×N (reusing
  `flow.loop`'s parallel map + `iterationConcurrency`), and applies a **bundled**
  aggregation policy (`majority-vote-on-field` / `threshold-count` / `best-of`
  by score / `synthesize` by a final agent reading all N). Optional `lens[]`
  gives each of the N a distinct perspective (adversarial-verify variant: each
  tries to refute). Output `{ result, samples[] }`. Bundling aggregation means
  it does NOT depend on D6③. Discoverable + the signature harness pattern.

- **D6③ — reduce/aggregate (recommend-and-proceed, mechanical).** Add a real
  `data.aggregate` node (ops: collect / concat / merge-objects / group-by /
  dedupe / numeric / custom-expression reducer, reusing `evalItemExpression`)
  and let `flow.join` optionally apply it (gather → reduce in one). Replaces the
  sum-only `data.transform` reduce stub. Not a load-bearing user fork.

- **D7 — Editor auxiliary facilities serve the new orchestration units, not the
  reverse.** Run observability, version history + diff, autosave, and an
  eval/test harness are most valuable precisely because published callable units
  must be _reliable, versioned, and testable_. (Build order / which facilities —
  TBD, next branch.)
