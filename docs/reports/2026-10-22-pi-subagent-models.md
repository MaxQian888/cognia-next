# Pi custom subagent models

Implemented and verified on 2026-10-22 (Asia/Shanghai). Research baseline: [Pi executor comparison](2026-10-21-pi-subagent-implementations.md).

## Behavior and configuration

Cognia detects an enabled, already installed npm executor on the execution host before exposing Pi child-model controls or loading that executor into a Cognia gateway task. The reviewed contracts are Nico `pi-subagents@0.80.0` and the locally installed `@gotgenes/pi-subagents@19.2.2`. Missing, disabled, filtered, broken and other-version packages do not enable this capability; conflicting enabled supported executors are refused. Runtime discovery is read-only and does not install, upgrade or rewrite user configuration.

Configure each custom agent through its existing native Markdown file, for example:

```markdown
---
name: reviewer
description: Review code
tools: read, grep
model: cognia/review-model
---

Review the requested changes.
```

Keep other agents without a `model` field to use Cognia's existing **Default subagent model** control. That control appears only after successful package detection. No separate agent definition store or duplicated per-agent picker was introduced. The importer now retains native model hints.

Precedence is an explicit native agent model (including Nico user/project `agentOverrides`) first, then an admitted explicit call model, then Cognia's configured child default, then Nico's native child default, then the primary model. Explicit `inherit` follows the current parent, including a nested parent. A fallback is never materialized as an explicit agent-file model. Other Markdown fields retain their YAML styles, because Nico's native flat parser handles those styles differently.

Models must belong to the task's existing provider/account route. Explicit models are included in the gateway model plan and catalog before the lease is minted. Invalid, unadmitted or cross-provider choices error instead of falling back silently. Both the `cognia` provider and the original provider qualifier resolve through the same task gateway; no extra native credentials are copied.

Standard discovery reads user `agents/*.md` and project `.pi/agents/*.md`. Nico discovery is recursive, skips `.chain.md`, and finds the nearest ancestor project `.pi` root. Project definitions and project model overrides win over user choices. Gotgenes keeps its immediate-directory, exact-name-first then case-insensitive contract. Existing definition digests are checked at startup and before child dispatch; changes require a new task.

## Runtime integration

The adapter explicitly loads only the detected executor before Cognia's verified extension. Task-owned Pi settings contain the executor and guard paths so child SDK loaders use the same guard. Nico additionally uses its public required-child-extension registry with `requireForAllRunners: true`; incompatible external/machine runners are refused through that native contract. Node and Rust task writers permit bounded safe `pi/agents/<name>.md` leaves and retain private task-file cleanup.

Synchronous editor validation provisionally checks the Pi child role's structure. Host configuration saves and task admission repeat actual host discovery. The legacy local Settings dialog also awaits discovery before its final model validation. The UI never persists the detection snapshot, and host writes strip any incoming ephemeral snapshot.

## Verification

- Focused Jest regressions cover package gating/conflicts/version/removal, editor and host-save checks, actual working-directory selection, model admission/projection/import, adapter extension/tool/root injection, routing precedence, unsafe calls and file cleanup. Final totals are recorded in the evidence ledger.
- Rust: `cargo test -p cognia-sandboxd --lib gateway_task::tests` — **12 passed**, including dynamic Pi Markdown path validation.
- Extension packaging: `node --test scripts/build/lib/stage-pi-extension.test.mjs` — **13 passed**; `pnpm pi:extension:pin:check` passed.
- Scoped ESLint with zero allowed warnings, Prettier, Rust formatting and `git diff --check` were used; `pnpm lint:i18n` passed. There are no new Pi UI strings or translation keys.
- The Pi adapter's ESM/CJS artifacts were rebuilt with `tsup --no-dts`.
- Actual local Pi **1.3.0** processes ran the two exact executor versions against a loopback Chat Completions fixture. The real adapter, task materializer and bundled/hash-verified guard were used. Each family exercised explicit project model `review`, omitted project model `default`, explicit `inherit` as `primary`, original provider-qualified model `search`, an omitted **global-only** agent with explicit call model `search`, and a background child preserving `review`. Each child's native write was blocked; the target file remained absent. Full request/event evidence is under `.cache/pi-subagent-models/native/2026-10-21T16-00-29.935Z/` (UTC directory timestamp).

Run the native check again with:

```bash
rtk proxy node scripts/smoke/build-and-run-smoke.mjs --pi-subagent-models
```

Nico's validation-only dependencies live under ignored `.cache/pi-subagent-models/nico-runtime`; Gotgenes was loaded from its existing installation. The smoke script never installs either package and accepts `NICO_SUBAGENTS_DIR`, `GOTGENES_SUBAGENTS_DIR` and `PI_BIN` overrides. No global Pi package settings were modified.

## Boundaries and remaining evidence

This supports named custom-agent single/parallel/chain call structures and foreground/background execution for the reviewed releases. Workflow scripts, named chains, management/scheduled launches, alternate child workspaces, custom scan directories and provider-specific Nico override maps are refused where they would bypass the admitted snapshot. Legacy `.agents`, package-defined agent catalogs and other executor versions are not part of this contract; unknown agent launches fail explicitly.

Nico has a public required-load contract. Gotgenes 19.2.2 does not provide an equivalent fail-on-guard-load contract: the native proof establishes successful guard loading and denied tools, not behavior under arbitrary SDK loader corruption. Existing gateway ticket PII checks and stripped credentials remain the final outbound boundary. The loopback fixture is not a live provider or actual ticket-gateway acceptance test.

The browser Agents settings route rendered, but that browser had no connected execution host. It did not validate detected-package controls against the local host; package visibility and delayed detection were verified through component tests. No new Tauri/VM/device acceptance is claimed.

`pnpm typecheck` and coverage were not run. An initial `pnpm dev` attempt unexpectedly invoked its dependency declaration-build prerequisite; it was stopped, and the UI server was launched directly with `next dev`. The explicit Pi package build used `--no-dts`. A broad Jest worker-exit warning was observed; the focused tests still exited successfully. The diagnostic `--detectOpenHandles` run was interrupted after a temporary import-placement regression had been corrected; it is not counted as a passing run.
