# Opus Lead → Codex Worker — Feasibility & Remediation Plan (2026-07-15)

**Status:** nothing here is implemented. This document is the output of a read-only
investigation plus one throwaway runtime probe. No production code was changed.

**Goal being evaluated:** run an Agent Team where an **Opus-backed lead** plans and reviews,
and a **Codex (`gpt-5.6-sol`) teammate** writes the code.

**Verdict:** the shape is supported — in fact it is the _only_ shape the team runtime
supports — but it **cannot run today**. One blocking defect (W1) fails the run precisely in
the configuration this goal requires, and the reviewer half has no non-GitHub implementation.

---

## 0. How to use this document

Each work item is self-contained: problem → evidence → fix → verification. Items are
independent unless a **Depends on** line says otherwise. One commit each.

### 0.1 Confidence labels

| Label           | Meaning                                                                 | What you must do                                      |
| --------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| **[PROBE]**     | Executed against the real code; output pasted verbatim below.           | Trust it. Re-run the probe if you doubt it.           |
| **[CONFIRMED]** | Read end-to-end by the investigation lead; file:line checked directly.  | Trust, but re-locate by symbol — line numbers drift.  |
| **[AGENT]**     | Verified by a subagent with quoted evidence; not independently re-read. | **Re-verify the specific claim before acting on it.** |
| **[OPEN]**      | Genuinely unresolved; needs a human decision.                           | **Do not decide it silently.** See §4.                |

### 0.2 Line numbers are as of 2026-07-15 on `dev` with a dirty tree

The working tree is shared with other agent sessions and carries **uncommitted** work
(including a fix this plan depends on — see W0). Re-locate by symbol, not by line.

---

## 1. What already works (do not rebuild it)

| Capability                                                | State                  | Evidence                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role: "lead"` that plans but never executes              | **works**              | `agent-team-runtime.ts` — `workers = allMembers.filter(m => m.role === "teammate")`; the lead is excluded from dispatch. [AGENT]                                                                                              |
| Teammate backed by an external CLI                        | **works**              | `lib/ai/agent/team/resolve-external-backing.ts:29-32` via `dispatchTeammate`. [AGENT]                                                                                                                                         |
| `codex` runtime actually launching `codex app-server`     | **works**              | `ecosystem-adapters.ts:61-78` (`codex` + `args:["app-server"]`); `presets.ts:415-424` `resolvePreferredCodexExecutablePresetId()` prefers it when the CLI is on PATH; applied at `resolve-external-backing.ts:60-62`. [AGENT] |
| Codex inheriting `~/.codex/config.toml` (⇒ `gpt-5.6-sol`) | **works, by omission** | No `-c model=` / `--model` builder exists in `lib/ai/agent/`; `crates/cognia-external-agent/src/process.rs:246-256` never calls `env_clear()`, so `CODEX_HOME` resolves normally. [AGENT]                                     |
| Plan → store → approval UI (the old "P4 hang")            | **fixed**              | `agent-team-runtime.ts:422-425` writes `{status:"awaiting_approval", proposedPlan}`; `:434` pushes `openApproval`; `:437` waits; `:443` clears. [CONFIRMED]                                                                   |
| Risk→ceremony gate (ADR-0070)                             | **live, default-on**   | `agent-team-runtime.ts:364-367`; deterministic, no LLM. [CONFIRMED]                                                                                                                                                           |

**Consequence for the goal:** "Opus lead + Codex worker" needs no new architecture. The lead
already cannot touch the repo, and the worker already runs on 5.6. The work is in W1–W7.

---

## 2. W0 — Do not lose the uncommitted freeze fix (blocking dependency)

**Problem.** Creating _any_ external agent (e.g. a Codex `app-server` instance) hard-froze the
desktop app and stayed frozen across restarts. Without this fix, none of this plan is testable.

**Evidence [AGENT].** `stores/agent/external-agent-store/selectors.ts` hydrated
`createdAt`/`updatedAt` with `new Date(...)` _inside_ the selectors, so every call minted new
objects → `useSyncExternalStore` never saw a stable snapshot → infinite render loop. The
renderer heartbeat could not fire while the thread spun, so the Rust `webview_watchdog`
declared the webview dead and reloaded — making the log read like a _spawn_ failure. Fixed
2026-07-15 on `dev`, via a module-level `WeakMap` + `hydrateAgentConfig(stored)`.
**The fix is uncommitted.**

**Action.** Before starting W1, confirm the fix is still in the tree (`hydrateAgentConfig`
exists in `selectors.ts`) and get it committed. Two traps recorded with it: `useShallow` does
**not** save you (it compares element references), and the co-located component test cannot
catch it (it mocks the store; you need `renderHook` against the real store hook).

---

## 3. Work items

### W1 [P0 — BLOCKER] `runLeadPlanning` can never resolve a provider

**Problem.** Lead planning throws on every invocation, in every environment. This is not a
hang (that was the old P4, now fixed) — it is a hard failure that fails the whole run.

**Evidence [PROBE].** `runLeadPlanning` calls the executor with only a system prompt
(`lib/ai/agent/agent-team-runtime-deps.ts:160-163`):

```ts
const result = await executeAgent(prompt, {
  systemPrompt: effectiveSystem,
  abortSignal: signal,
})
```

`executeAgent` takes the sidecar branch **only** when `config.toolsEnabled` is set
(`agent-executor.ts:474`); lead planning does not set it, so it falls to the text channel.
That channel builds its provider snapshot **purely from the config argument** —
`createProviderSettingsSnapshot` (`lib/ai/provider-consumption.ts:257-265`) is a pure wrapper
and `executeAgent` reads **no store** (`providerSettings` appears exactly twice in
`agent-executor.ts`: the type at `:89`, the pass-through at `:497`). With nothing passed, the
snapshot is empty → `resolveFeatureProvider` builds zero candidates → `unresolved`
(`provider-consumption.ts:403-434`) → `agent-executor.ts:512-513` throws → `deps.ts` rethrows.

Probe (temporary test, since deleted), calling `executeAgent` with exactly `runLeadPlanning`'s
argument shape:

```
PROBE_RESULT: {"threw":true,"message":"executeAgent: No candidate providers were available."}
```

This is **environment-independent**: the path reads no settings store, so it fails regardless
of what providers the user has configured in the app.

**Why this goal triggers it deterministically.** `riskGating` defaults to `true`
(`types/agent/agent-team.ts:635`). A Codex teammate can shell out → the deterministic
classifier raises the tier → `requiredCeremony(...).requirePlanApproval` → the gate opens even
though the operator never set `requirePlanApproval` (`agent-team-runtime.ts:364-367`) → lead
planning runs → throws. **An Opus-lead + Codex-worker team fails by construction.**

**Why tests are green.** `agent-team-runtime.test.ts` injects a fake executor through
`opts.executeAgent` (`deps.ts:128`), so the real resolution path is never exercised.

**Fix.** Thread provider settings into `runLeadPlanning`'s executor call. **Do not write a new
resolver** — `lib/agent-team/provider-model.ts` (`buildTeamClaudeRuntimeModel`) already does
exactly this resolution for the team, but is currently wired only into the `@mention` chat
bypass (`app/agent-teams/workspace/page.tsx:168`). Either reuse it or pass
`providerSettings` / `defaultProvider` / `customProviders` from `AppSettings` into
`executeAgent`. Note `executeAgent` already accepts `provider`, `defaultProvider`,
`providerSettings`, and `model` — the type is not the problem; the call site is.

**Consequence to accept [OPEN].** The lead then runs on the **global** default provider/model.
Pointing that at Opus makes the lead Opus — but it is **not per-team configurable**, and
`AgentTeammateConfig.model` / `.runtime` remain ignored for the lead (`deps.ts:160-163`).
Per-team lead model selection is a separate feature; do not smuggle it in here.

**Verification.** A test that calls the **real** `runLeadPlanning` (not a fake executor) with
a populated `AppSettings` and asserts a plan comes back; plus one asserting the empty-settings
case fails with a _useful_ message rather than `No candidate providers were available.`

---

### W2 A risk-raised gate asks for approval but shows no plan

**Problem.** The operator is asked to approve a plan they cannot see — the exact scenario this
goal creates (risk-raised, not operator-set).

**Evidence [CONFIRMED].** The runtime opens the gate on
`Boolean(team.config.requirePlanApproval) || riskRaisedGate` (`agent-team-runtime.ts:367`),
but the inline panel gates on the config flag alone — `components/agent/workspace/overview.tsx:261`:

```tsx
{
  team.config.requirePlanApproval && lead?.status === "awaiting_approval" && (
    <PlanApprovalPanel team={team} lead={lead} />
  )
}
```

So when `gateIsRiskOnly` is true (`:371`), the panel never renders. `GateModalsHost` still
answers the gate, but the modal renders only `props.body` (`approval-gate-dialog.tsx:101`) and
has no plan branch. Not a hang — a **blind approval**.

**Fix.** `lead?.status === "awaiting_approval"` is alone sufficient and correct (`:443` clears
it on any decision/abort). Drop the config-flag conjunct. [AGENT]

**Depends on:** W1 (unreachable until lead planning can produce a plan).

---

### W3 [OPEN] Codex model passthrough is a dead chain

**Problem.** `teammate.config.model` never reaches Codex. Today `gpt-5.6-sol` is obtained
**by omission** — Codex falls back to its own `config.toml` default.

**Evidence [AGENT].** Three independent breaks:

1. `lib/ai/agent/team/dispatch-teammate.ts:276-289` — the `manager.execute` payload carries
   systemPrompt / permission / cwd / mcpServers / onEvent. **No model.** `modelHint` (`:410`)
   reaches only the sidecar and text channels (`:545-551`). [CONFIRMED — re-read directly]
2. `ExternalAgentExecutionOptions` (`types/agent/external-agent.ts:1832-1892`) has **no
   `model` field**, and `manager.buildSessionOptions` never reads one. The subagent path
   (`lib/plugin/agent-sdk/dispatch.ts:314-316`) _appears_ to forward `def.model` and is
   silently dropped — **no type error**, because TS excess-property checking does not apply to
   spread members.
3. The consumer end is fine: `codex-app-server-client.ts:531-532` reads
   `metadata.selectedModel` into `thread/start params.model`, unvalidated (any id works). The
   only writer is the interactive `setSessionModel`, which no component calls.

Also dead: `listModels()` (`:1820-1838`) is called from nothing but its own tests, so
`modelCache` is always empty → `getSessionModels` returns `unsupported` → **no Codex model
picker can populate**. There is no filter that would reject `gpt-5.6-sol` — there is no UI at all.

**Decision required.**

- **(a) Accept the omission.** Zero code. Costs: cannot give two Codex teammates different
  models; a `config.toml` edit silently re-models the whole team; no in-app visibility of which
  model ran.
- **(b) Make it first-class.** Add `model?: string` to `ExternalAgentExecutionOptions`, map it
  to `metadata.selectedModel` in `buildSessionOptions` (unblocks both callers at once), and
  pass `teammate.config?.model ?? modelHint` from `runExternalBacked`. Optionally call
  `listModels()` after `initialized` to make a picker viable.

Recommendation: **(a) now, (b) when a second Codex model is actually needed.** The goal does
not require (b), and (b) touches the shared manager surface.

---

### W4 The codex env overlay can fight a custom provider

**Problem.** cognia may inject credentials/endpoint env that conflicts with a
`model_provider = "custom"` setup — silently, without opt-in.

**Evidence [AGENT].** `lib/ai/agent/external/env-builder.ts:81-125` fires for both codex
presets. `preferDiscovered` defaults **true** (`types/subscription/usage.ts:76-77`), so with no
cognia codex account, cognia reads `~/.codex/auth.json` itself and injects it. With an
account + attached ProviderPreset, `crates/cognia-subscription/src/codex/mod.rs:64-101` pushes
`OPENAI_API_KEY`/`CODEX_API_KEY`, `OPENAI_BASE_URL` (`:89`), and `OPENAI_MODEL` (`:96`).

Assessment for this setup (`requires_openai_auth = true`, `base_url = https://ai-pixel.online`,
auth is a bare `OPENAI_API_KEY` in `auth.json`):

- Injecting the same discovered key is likely **benign or identical** — but it is not opted into.
- `OPENAI_BASE_URL` injection **fights** `config.toml`'s `base_url` if a preset is attached.
- `OPENAI_MODEL` is **dead weight** — Codex takes its model from config/`--model`, not that env
  var. A preset `modelMapping.default = "gpt-5.6-sol"` will **not** set the model.

**Mitigation (no code).** Merge order is overlay-first, then `baseEnv`
(`env-builder.ts:64-67`), so values typed into the agent's Settings env **win**. Setting
`CODEX_HOME` there also works, since the spawn never clears env.

**Fix (optional).** Gate the overlay on an explicitly adopted account rather than
`preferDiscovered: true`.

---

### W5 Teammate→Codex binding is preset-only

**Problem.** N Codex teammates collapse onto one CLI process; per-instance config (cwd, env,
auth, `codexOptions`) is unreachable.

**Evidence [AGENT].** `lib/ai/agent/team/resolve-external-backing.ts:70`:

```ts
const existing = manager.getAllAgents().find((inst) => isFromPreset(inst.config) === presetId)
```

The per-run cache is preset-keyed too (`team-run-context.ts:129`,
`Map<string, string>`, documented as "all teammates backed by the same external preset reuse
one spawned CLI process"). A repo-wide grep for `externalAgentInstanceId` returns **zero
hits** — an earlier audit recorded this field as implemented; that work was lost.

**Impact on the goal:** none for a single Codex worker. Blocks "two Codex workers in parallel
with different cwd/worktrees".

---

### W6 Runtime picker drift; the anti-drift helper is an orphan

**Evidence [AGENT].**

- `components/agent/workspace/members.tsx:65` uses `["claude", ...BUILTIN_EXECUTABLE_PRESET_IDS]` → includes `codex-app-server`.
- `components/agent/workspace/teammate-config-dialog.tsx:65-71` hard-codes 5 of 13 runtimes and **omits** `codex-app-server` → opening the config dialog on such a teammate shows a Select with no matching item.
- `components/agent/workspace/runtime-options.ts` documents itself as the shared source
  "so the two surfaces can never drift" — its **only importer is its own test**. The file
  exists, is tested, and prevents nothing; the drift it was written to prevent shipped.

**Fix.** Import the already-written, already-tested `RUNTIME_OPTIONS` in both surfaces.

---

### W7 [OPEN] There is no reviewer that can block

**Problem.** The goal's "Opus as reviewer" has no ready implementation. The default DAG emits
only `action.team.task.dispatch` (`synthesize-workflow.ts:134`); the registered `action.team.*`
kinds are `run/create/update/task.dispatch/reconcile` — **no review/verify kind**. [AGENT]

Three existing mechanisms, all opt-in, none of them a blocking per-member gate:

| Option                                                            | What it is                                                                                                                                                                                                                         | Cost                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(A) PR reviewer** — `lib/ai/agent/team/pr-feedback/reviewer.ts` | Real reviewer role: `REVIEWER_SYSTEM_PROMPT`, `verdict: "approved" \| "changes_requested"` schema; `changes_requested` routes a `review_pickup` nudge back to the authoring teammate via the reaction engine (dedup + hourly cap). | Requires **all** of `prFeedback.enabled` + `reviewer.enabled` + `workspaceAllocator` + `config.workingDir` + `resolveTeamRepo` + `resolvePrObserveOctokit` (GitHub creds; fail-closed off-desktop). Runs **after** the DAG settles — observes and nudges; **cannot block a task or the run**. |
| **(B) DAG review node**                                           | A new `action.team.*` review kind that runs after a member's task and can fail/loop it.                                                                                                                                            | New subsystem: ADR + workflow node + tests + i18n. The only option that actually blocks.                                                                                                                                                                                                      |
| **(C) Ultracode patterns**                                        | `pattern.adversarial-verify`, `pattern.judge-panel`, `pattern.completeness-critic` (`team/patterns/index.ts`), registered at `agent-team-runtime.ts:800`.                                                                          | Gated on `isUltracodeActive` (`config.ultracode.enabled` + assessment, or a `"force"` override). Verification-shaped, not a review gate over a teammate's diff.                                                                                                                               |

**Recommendation.** If "review" means _catch bad code before it lands_, only **(B)** delivers
it; (A) is a post-hoc nudge loop that presumes GitHub. Decide before writing code.

---

## 4. Open decisions

1. **W3** — accept `config.toml`-by-omission (recommended), or make Codex model first-class?
2. **W7** — (A) reuse the PR reviewer with its GitHub dependency, (B) build a blocking DAG
   review node, or (C) enable ultracode patterns?
3. **W1 consequence** — is a globally-configured lead model acceptable, or is per-team lead
   model selection in scope? (It is a separate feature; do not fold it into W1.)

---

## 5. Verification commands

Repo gates (per `CLAUDE.md`); note the recorded baselines before trusting a red result:

```bash
pnpm test -- lib/ai/agent/agent-team-runtime.test.ts
pnpm test:coverage:changed -- --strict     # known broken branch-wide (picomatch 65536)
NODE_OPTIONS=--max-old-space-size=16384 pnpm typecheck   # ~56 pre-existing errors in 31 files
pnpm lint:i18n
```

**Baselines that are red before you start** (do not chase them):
`typecheck` (56 errors / 31 files), `eslint .` repo-wide, `lint:i18n` sort-check, and
`stores/agent/external-agent-store/slices/actions.slice.test.ts` (`upsertBenchmarkCapability`).
Gate on **your** files only.

**End-to-end check that actually proves the goal** (after W1): create a team with an
Opus-backed lead and one `codex` teammate, run it, and confirm (a) the plan renders in the
approval panel, (b) approving starts the run, (c) the Codex process is `codex app-server`
inheriting `config.toml` (⇒ 5.6), (d) the run completes. Tests alone will not prove this —
`opts.executeAgent` fakes hide W1 entirely.

---

## 6. Non-goals / ruled out

- **`codex exec` / `@zed-industries/codex-acp`.** Not used when the CLI is on PATH; the ACP
  shim is the fallback preset only (`ecosystem-adapters.ts:83-100`).
- **A Codex model picker.** Dead end until `listModels()` is called in production (W3).
- **Per-instance teammate binding (W5).** Not required for a single Codex worker.
- **The Claude Code `codex` plugin path** (`~/.claude/plugins/.../codex-companion.mjs`).
  A different product surface — out of scope for cognia's Agent Team.
