# Cognia CLI/TUI completion plan (2026-07-25)

**Status:** proposed after adversarial review  
**Scope:** verified defects in `cli/src/tui` and adjacent CLI config, agent, database, and runtime
paths  
**Research basis:** [`docs/research/tui-current-state-gap-audit-2026-07-25.md`](../research/tui-current-state-gap-audit-2026-07-25.md)

## 0. Baseline and exclusions

Do not execute the 2026-07-15, 2026-07-16, or 2026-07-24 plans wholesale.

- `cli/src/tui` has 310 production TypeScript files and about 50.7k lines.
- The focused TUI run on 2026-07-25 passed **302 suites and 4,101 tests**.
- External-agent G1–G8, the planned bottom region, transcript cursor/find, destructive edit/fork,
  OSC52 copy, Ctrl+L, and subagent live rendering are implemented.
- `pnpm smoke:external-parity` already drives real Codex app-server, Codex ACP, and Claude Code ACP
  through the real sandbox, broker, and bridge. It verifies read, write, host-tool, approval, and
  file-side-effect behavior. Do not add a duplicate conformance command.
- No coverage run, production build, or authenticated real-agent smoke was executed during this
  planning pass.

This plan intentionally excludes worktree isolation, ACP terminal support, local scheduler
execution, and local team execution. They are possible product extensions, not verified defects
with an agreed user contract. Create separate proposals if a concrete requirement appears.

## 1. Triage

Use delivery classes instead of P0/P1/P2 labels; the prior severity labels mixed runtime impact,
quality policy, and optional enhancements.

| Class                    | Work                                         | Why it belongs here                                                                                                         |
| ------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Fix now                  | Hooks config contradiction                   | The TUI emits a `hooks` example that strict config parsing rejects.                                                         |
| Fix now                  | MCP preset requiredness                      | Header placement is incorrectly treated as optionality; GitHub auth may be omitted while GitLab's optional URL is required. |
| Fix now                  | Snapshot flush/dispose failures              | Current async scheduling can create an unhandled rejection and a failed final flush cannot be retried.                      |
| Fix now                  | SIGTERM/SIGHUP and null rejection handling   | Both have concrete terminal/session wedge mechanisms.                                                                       |
| Establish early          | CLI/TUI coverage enforcement                 | `.tsx` is excluded, no CLI-specific threshold exists, and `FormOverlay` lacks a co-located test.                            |
| Implement after contract | Native model-shell boundary                  | External agents fail closed, but the built-in CLI does not project the existing ADR-0028 sandbox settings.                  |
| Implement in two stages  | Memory recall/search, then optional learning | Manual memories are not recalled or searchable; automatic extraction has separate consent/cost/PII concerns.                |
| Required compliance      | CLI-native localization                      | Hard-coded TUI strings conflict with repository i18n policy; Ink needs a non-`next-intl` resolver.                          |
| Measure first            | Startup and long-history performance         | Source mechanisms remain, but the old benchmark was not rerun and does not justify virtualization by itself.                |
| Optional hardening       | Broker report correlation                    | It protects audit/display integrity; it is not an execution-authority bypass.                                               |

## 2. Work packages

### W0 — Repair configuration contracts

#### MCP presets

1. Add explicit field requiredness independent of `placement`.
2. Default existing fields to required for compatibility.
3. Mark genuinely optional fields, including GitLab's API URL, as optional.
4. Make `requiredFieldKeys`, `missingPresetFields`, the preset document, guided forms, copyable Add
   commands, and persistence consume one predicate.
5. Test GitHub's required Authorization header and GitLab's optional URL.

#### Hooks

Choose one coherent contract before editing:

- **Recommended:** admit a validated `hooks` field in `cliConfigFileSchema` and reuse
  `HooksConfigSchema`; or
- remove Cognia-local hooks from the loader/onboarding and document only Claude Code hooks plus
  `builtinHookOverrides`.

If Cognia-local hooks remain:

1. the exact JSON emitted by `/hooks` must parse through `resolveConfig`;
2. `loadHooks` must receive the same validated shape rather than reparsing around the schema;
3. invalid hook entries must produce an actionable config error, not silently erase all hooks;
4. command-hook execution remains covered by the current timeout, matcher, and process tests.

**Verification**

```bash
rtk proxy pnpm exec jest cli/src/mcp cli/src/hooks cli/src/config cli/src/tui/runtime/mcp-controller.test.ts cli/src/tui/runtime/hooks-controller.test.ts --runInBand
rtk pnpm typecheck
```

### W1 — Enforce CLI/TUI test coverage

Do this before adding memory, sandbox, or localization code.

1. Add `FormOverlay.test.tsx` for text, enum, boolean, navigation, required errors, submit, and
   cancel.
2. Remove the dormant `Overlay` variants `slash` and `files` after a final positive-control
   reference search.
3. Collect `cli/src/**/*.{ts,tsx}`, excluding only type-only modules and the executable wrapper.
4. Add a CLI aggregate threshold for fast feedback.
5. Extend the existing coverage ratchet/report to enforce **each collected CLI source file** at
   90% statements, branches, functions, and lines. A single Jest glob threshold is insufficient
   because well-covered files can hide an under-covered file.
6. Add a source/test inventory gate for new CLI components.

**Exit criteria:** `pnpm test:coverage` and the per-file ratchet enforce the CLI surface without
weakening another group or adding broad exclusions.

### W2 — Make snapshot failure recoverable and visible

1. Catch scheduled flush errors at the debounce boundary.
2. Preserve the last good snapshot, backup, and dirty state on write/fsync/rename failure.
3. Let the next normal scheduled or explicit flush retry the dirty state; do not add an independent
   background retry/backoff subsystem.
4. Surface the latest persistence failure through the TUI/operator channel.
5. Mark disposal complete only after the final flush succeeds.
6. Permit a failed `dispose()` to be retried; keep successful disposal idempotent.
7. Clear the cached DB handle only after successful disposal, or retain an explicit retryable
   error state.

**Required tests**

- scheduled write failure is handled without an unhandled rejection;
- the previous snapshot remains readable after write/fsync/rename failure;
- a later normal flush succeeds;
- first `dispose()` fails, second succeeds, third is a no-op;
- failure reporting leaves no orphan timer.

### W3 — Close concrete terminal/session resilience gaps

1. Route SIGTERM and SIGHUP through the same owner as normal exit.
2. Restore bracketed paste, mouse mode, title, and alternate screen in every signal path.
3. Cancel the active turn and attempt the existing DB final flush before exit.
4. Convert arbitrary rejection values safely; `Promise.reject(null)` must still dispatch
   `TURN_ERROR`.
5. Guarantee busy/abort cleanup in `finally`.
6. Add a reducer/UI sink to process crash guards so an async failure is both logged and visible.

Do not add cell- or overlay-level React error boundaries in this package unless a reproducible
local render failure shows that the app-wide boundary is insufficient. That earlier proposal had
no current failure case and would multiply recovery states.

**Required tests:** SIGTERM/SIGHUP during idle and streaming; `null`/`undefined` rejection; async
fault produces one durable log record and one visible error state.

### W4 — Project the existing ADR-0028 shell boundary into CLI

**Decision required:** explicit user-entered `!command` and model-selected `bash` are different
trust surfaces.

Recommended contract and implementation:

1. Add typed CLI settings that map losslessly onto the existing app settings consumed by
   `lib/claude/build-options.ts`: `sandboxDefaultEnabled`, `sandboxTier`, `sandboxPolicy`, and
   `workspaceConfinementEnabled`.
2. Resolve them with the normal CLI precedence: command-line override, environment, project
   config, user config, then the existing application defaults. Workspace confinement remains on
   by default.
3. Synthesize the `activeProject` passed to `resolveSendOptions` from the resolved working
   directory and additional roots. Without this projection, the existing confinement branch
   cannot activate.
4. When strict sandboxing is enabled, model-selected shell/file mutations must use the existing
   ADR-0028 `sandbox_*` tool path. Before a turn starts, verify that the bundled
   `cognia-sandboxed-tools` plugin is present and eligible. If it is not, refuse the strict-mode
   turn with an actionable error; never restore native mutation tools as a fallback.
5. When strict sandboxing is disabled, preserve the existing workspace-confinement policy through
   the projected `activeProject` and roots.
6. Keep explicit `!command` as a clearly labeled trusted-local action unless product explicitly
   chooses a separate sandboxed mode for it.
7. Make `/doctor` report model-tool confinement, strict-sandbox readiness, and trusted-local `!`
   behavior as separate facts.

Reuse `lib/claude/build-options.ts` sandbox and confinement resolution. Do not reuse
`cli/src/runtime/external/sandbox-launcher.ts` as a generic command sandbox: that launcher
intentionally grants home readability and network access for hosted agents, which conflicts with
the model-tool policy.

**Verification:** model-driven calls attempt workspace escape, credential-path access, network
access, child-process escape, and cancellation under each supported platform/tier. Test
`!command` against its separately documented contract.

### W5 — Add memory recall and search

This package is limited to the verified read-path gap.

1. Add a typed `memory` section to standalone CLI config using the existing `MemoryConfig` shape
   and `resolveMemoryConfig` defaults. Project config overrides user config, which overrides
   `DEFAULT_MEMORY_CONFIG`; do not read renderer Zustand state or add flags until a concrete
   operator need exists.
2. Resolve memory config once at CLI composition and pass it explicitly with the memory
   dependencies. Preserve `allowCloudEmbedding` exactly: disabled means BM25-only and must never
   initiate an embedding request.
3. Build CLI memory dependencies with the existing `tryBuildMemoryDeps`; retain its
   privacy-preserving fallback.
4. Refactor the shared search entry point so it accepts explicit config/dependencies, or extract
   the lower-level shared search operation. The CLI must not call a wrapper that internally reads
   desktop settings.
5. Add query-dependent recall to `createCliContextAssembler.resolveTurn`, outside the stable
   session cache.
6. Reuse `applyMemoryContext` and the shared ranking pipeline; do not create another scorer.
7. Add `/memory search <query>` with relevance-ranked results and a detail view.
8. Keep recall failure non-fatal but report disabled, temporary, or unavailable states truthfully.
9. Define whether CLI and desktop stores remain separate before adding synchronization.

**Acceptance:** save a fact, restart the CLI, ask a related question, and prove the fact enters the
turn context. Tests must cover enabled/disabled and temporary-memory config, project-over-user
precedence, cloud-embedding opt-out, and offline BM25 search without cloud credentials.

### W6 — Decide automatic memory learning separately

Automatic extraction, decay, consolidation, and synchronization are not prerequisites for W5.
They add outbound model/embedding calls, cost, retention behavior, and destructive maintenance.

Before implementation, write a focused proposal that defines:

- explicit opt-in and settings ownership in the standalone CLI;
- provider/credential resolution without renderer Zustand hydration;
- fail-closed PII behavior for every outbound call;
- contamination/evidence policy for external context;
- extraction deduplication and job durability;
- decay/consolidation invariants and user-visible deletion/review controls;
- whether any desktop synchronization exists.

Only then adapt `runTurnMemory` so settings are passed explicitly. Do not call the current function
unchanged from the CLI; it reads renderer store state and can silently do nothing.

### W7 — Add a CLI-native localization layer

The repository requires user-facing `.tsx` strings to be localized. The implementation choice is
not whether to localize, but how to do it without importing `next-intl` into Ink.

1. Reuse `lib/headless/i18n.ts` and the existing `i18n/messages/en.json` and
   `i18n/messages/zh-CN.json` catalogs. Add CLI keys to those catalogs; do not create a parallel
   pair.
2. Define `locale` as user-scoped CLI configuration plus a `--locale` override and
   `COGNIA_LOCALE`. A project config must not silently change the operator UI language.
3. Resolve locale in this order: `--locale`, `COGNIA_LOCALE`, user config, normalized OS locale,
   then `en`.
4. Normalize `zh`/`zh-*` to `zh-CN` and `en`/`en-*` to `en`. Reject an unsupported explicit
   flag/env/config value with an actionable error; silently fall back only for an unsupported OS
   locale.
5. Persist an interactive locale change to user config, never project config.
6. Inject the resolver into controllers/components; avoid mutable global locale state.
7. Migrate vertical surfaces in this order: startup/errors, composer/footer, overlays, controllers.
8. Keep both locales complete in every change.
9. Add precedence, normalization, persistence, key parity, unused-key, interpolation, and
   English/Chinese render tests.

### W8 — Measure before optimizing rendering/startup

The following are candidates, not approved rewrites:

- highlight-before-cap for large results;
- eager CLI/TUI command imports;
- unstable verbose cell objects and non-memoized `CellView`;
- uncached/full tool-card diffs;
- non-virtualized fullscreen transcript;
- paced-reveal interval churn.

#### Phase A — establish budgets and reproduce

1. Benchmark fresh-built `help`, `version`, `run`, and TUI startup.
2. Measure key-to-frame latency and peak RSS for 10, 100, 1,000, and 5,000 mixed cells at 40×12,
   80×24, and 120×40.
3. Profile large tool results and diffs separately.
4. Record numeric pass/fail budgets in the benchmark before changing production code.

#### Phase B — optimize only measured bottlenecks

Prefer cap-before-highlight and lazy import changes when profiles prove them. Require behavior
equivalence tests for multiline highlighting and command registration.

Transcript virtualization is a separate go/no-go decision. Authorize it only when a measured
1,000/5,000-cell case violates the agreed interaction budget. Its acceptance must preserve find,
selection, context folding, click targeting, backtrack, and jump-to-latest behavior.

### W9 — Optional broker report correlation

This is defense-in-depth and may be deferred independently.

If selected:

1. mint a one-shot call id during built-in-tool authorization;
2. bind the report to server, tool, attempt, context version, and session;
3. consume the id once;
4. reject unknown, duplicate, stale, or mismatched reports.

Keep the existing `pnpm smoke:external-parity` command. A release process may record its results,
but no second conformance implementation is needed.

## 3. Delivery order

```text
W0 configuration contracts
  ├─ W1 coverage enforcement
  ├─ W2 snapshot durability
  └─ W3 terminal/session resilience

After W1:
  W4 model-shell boundary
  W5 memory recall/search
  W7 localization

Independent evidence track:
  W8 benchmarks → only measured optimizations

Decision-gated:
  W6 automatic memory learning
  W9 broker report hardening
```

W0–W3 are independent enough to be separate commits; W1 is a gate for later feature expansion,
not a dependency of the existing bug fixes.

## 4. Final verification

Run from a clean, current worktree:

```bash
rtk proxy pnpm exec jest cli/src/tui --runInBand
rtk pnpm cli:test
rtk pnpm test:coverage
rtk pnpm coverage:ratchet
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm lint:i18n
rtk pnpm format:check
rtk pnpm cli:build
rtk pnpm build
rtk git status --short
```

Run `pnpm smoke:external-parity` only in an authorized environment with installed, authenticated
agents; it spends real tokens.

Also verify the work packages that landed:

- SIGTERM/SIGHUP cleanup;
- model-tool sandbox/confinement escape fixtures;
- restart-and-recall memory flow;
- English and Chinese operator journeys;
- benchmark budgets for any accepted performance change.

Update the English and Chinese TUI subsystem docs by removing volatile hand-maintained counts or
replacing them with stable capability descriptions. Do not add an inventory generator solely to
keep headline numbers current.

The plan is complete only when every selected package has source, co-located tests,
operator-visible failure behavior, and evidence from its stated gate.
