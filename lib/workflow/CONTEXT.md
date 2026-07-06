# CONTEXT — Workflow Orchestration & Skills Convergence

Domain language and load-bearing decisions for turning the Visual Workflow engine
into cognia's **orchestration harness**, and for how **skills** relate to it.
Keep this glossary stable; flag any usage that conflicts with it. Scope is the
visual workflow subsystem (`lib/workflow/`, `components/workflow/`,
`types/workflow/visual.ts`, `src-tauri/src/workflow/`) and its seam with
`lib/skills/`. Companion ADRs: 0011 / 0017 / 0022 / 0034.

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
equivalent of the harness `agent(prompt, { schema })`. Today `action.agent.turn`
returns **free text only** (`lib/workflow/nodes/actions/agent-turn.ts:133`) — the
output-schema half is the keystone gap.

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
`while`/`iterationConcurrency`/`items[]`). Only friction: `maxConcurrency`
defaults to **1**.

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
  - **Publishing registers 3 call surfaces:** ① a typed **agent tool** (the
    typed successor to the existing untyped `wf_run_workflow_by_name`), ② a typed
    **`flow.subworkflow`** target, ③ a **skill-catalog entry `kind:"workflow"`**.
  - **Graph-bodied skill behavior (the novel/irreversible part):** when a
    character enables it, a short **name+description is injected** (progressive
    disclosure — reuses the CLI's `renderSkillsCatalog` idiom, NOT the full
    `renderSkillsSection` body) AND a **tool is registered** that actually runs
    the graph. Model sees the description → calls the tool → graph executes →
    typed output returns. It is NOT injected as a prose playbook (that would lose
    deterministic execution — explicitly rejected).

- **D6 — Genuine net-new build targets (the real gaps):** ① structured output
  (D3, keystone) ② first-class ensemble / N-vote / adversarial-verify node
  (neither n8n nor Dify has one — a differentiator) ③ real reduce/aggregate
  (today `flow.join` only gathers; `data.transform` reduce is a sum-only stub).

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
