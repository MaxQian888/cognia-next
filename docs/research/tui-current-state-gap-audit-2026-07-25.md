# Cognia CLI/TUI current-state gap audit (2026-07-25)

## Scope and evidence standard

This is a read-only comparison of the current implementation under `cli/src/tui` and the
adjacent `cli/src/{agent,config,db,serve}` paths against:

- `docs/plans/2026-07-15-tui-audit-remediation.md`;
- `docs/plans/2026-07-16-tui-parity-and-industry-gaps.md`;
- `docs/plans/2026-07-24-tui-external-backend-launch-remediation.md`;
- the TUI-related design specs under `docs/superpowers/specs`.

The plans are historical inputs, not current truth. In particular, the 2026-07-16 plan already
warns that the 2026-07-15 blanket “none implemented” status had become stale, and the
2026-07-24 plan describes a baseline that has since changed substantially.

Classifications in this audit:

- **Implemented** — the production path is wired and a focused regression/contract test exists.
- **Partially implemented** — a meaningful subset landed, but the original acceptance contract
  is not met.
- **Still present** — the current production code still exhibits the stated mechanism.
- **Superseded** — a later architecture makes the original absence/framing obsolete.
- **Newly discovered** — not stated in the reviewed plans and supported by current source.

Evidence is primary repository source and tests. No claim of a green full suite, production build,
or real-vendor smoke is made here.

## Executive summary

The largest change since the plans were written is the external-backend stack. The 2026-07-24
G1–G8 architecture is now substantially present: a shared session/turn context assembler,
authenticated Cognia MCP tool host, host/plugin tool projection, context-version restarts,
capability diagnostics, lifecycle ownership, paced-reveal epochs, and a stable launch shell all
exist in production code with focused tests.

The three interaction specs are also mostly implemented: the two-layer bottom region and steer
queue, transcript find/cursor and ghost-text input, destructive edit/fork, OSC52 copy, `/copy`
variants, and Ctrl+L clear-screen are all wired.

The highest-value residual gaps are older ones:

1. GitHub MCP preset auth is still classified by transport placement instead of requiredness
   (N1).
2. `config.json.hooks` is still advertised and loaded but rejected by the strict config schema
   (N2).
3. CLI memory remains manual/write-only in the model path: no per-turn recall, semantic search, or
   auto-maintenance (W5–W7).
4. Model-selected native `bash` does not receive the existing ADR-0028 confinement/sandbox policy
   because the CLI resolver supplies neither `activeProject` nor sandbox settings. User-entered
   `!command` is a separate trusted-local product surface, not the same verified defect.
5. Large result highlighting, fullscreen transcript rendering, eager command imports, and
   `CellView`/diff rendering retain the 2026-07-15 source mechanisms (P1–P5), but the old
   performance measurements have not been rerun and do not justify a rewrite by themselves.
6. TUI SIGTERM/SIGHUP cleanup, null-safe turn error handling, TUI i18n, CLI-specific coverage
   thresholds, `.tsx` coverage, and subsystem documentation remain open.
7. Worktree isolation is still absent, although ACP hosting and local↔desktop handoff are no
   longer gaps.

## 1. 2026-07-15 remediation plan

### 1.1 Test-gate items

| ID                           | Current status           | Current source/test evidence                                                                                                                                 |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 POSIX path assertion      | **Implemented**          | `cli/src/config/logto-session.test.ts` now compares `logtoSessionPath(HOME)` with `path.join(HOME, "logto.json")`.                                           |
| T2 200k context-window drift | **Implemented**          | `model-meta.test.ts` asserts `128_000`; `status-controller.test.ts` describes and asserts the 128k/78% fallback; `status-bar.test.ts` covers the same basis. |
| T3 built-in agent list       | **Implemented**          | `mention/providers.test.ts` expects `["general-purpose", "Explore", "Plan"]`.                                                                                |
| T4 fabricated GLM shape      | **Implemented**          | `runtime/limits-data.test.ts` uses the real `{ unit: 3 }` and `{ unit: 6 }` rows.                                                                            |
| T5 Dexie cold-start timeout  | **Implemented**          | `serve/durability.test.ts` and `agent/subagent-background-tasks.test.ts` set a 30-second suite timeout.                                                      |
| T6 serve test is W1          | **Superseded by W1 fix** | The method-less window regression is now explicit in `resume-reconnect.test.ts`; the serve fixture no longer represents an intentionally accepted failure.   |

### 1.2 P0 and dormant-wiring findings

| ID                                 | Current status                          | Evidence and residual contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 serve boot crash                | **Implemented**                         | `startResumeReconnect` feature-detects `addEventListener` on both targets before registration (`lib/connectors/bootstrap/resume-reconnect.ts:startResumeReconnect`). The floating installer IIFE ends in `.catch(...)` (`install-connector-runtime.ts`). `resume-reconnect.test.ts` has the exact bare-global/method-less regression.                                                                                                                                                                      |
| W2 non-atomic snapshot/data wipe   | **Implemented**                         | `cli/src/db/bootstrap.ts:writeSnapshotAtomically` writes a synced temp file, preserves one `.bak`, renames, and syncs the parent. `parseSnapshot` returns `absent                                                                                                                                                                                                                                                                                                                                          | corrupt | valid`; corrupt/incompatible files are moved aside and raise `CliDbSnapshotError`. `bootstrap.test.ts` covers corrupt quarantine, version mismatch, atomic replace, and backup. |
| W3 stale PII-gate path trail       | **Implemented for active sources/docs** | Active governance now names `packages/redact/src/index.ts:hasNoLeakingPii` (for example `CLAUDE.md`). A repository search outside historical plans/research finds no stale `lib/twin/ingest/redact.ts` pointer except the intentionally fake grep-card story fixture; valid `redaction-key.ts` references remain.                                                                                                                                                                                          |
| W4 `autoRoute` dropped             | **Implemented**                         | `cliConfigFileSchema` and `ResolvedConfig` carry `autoRoute`; `config/mutate.ts` permits mutation; `toBuildContext` emits routing mappings/context when enabled. `to-build-context.test.ts` covers both off and on behavior, and `settings-sections.ts` exposes the toggle.                                                                                                                                                                                                                                |
| W5 memory write-only               | **Still present**                       | `/remember` and `/memory add` call `createMemory` through `runtime/memory-controller.ts`, but `createCliContextAssembler.resolveTurn` only adds attachments and twin context. No memory retrieval is added to `ResolvedCliTurn` or `sendOptions`. The standalone CLI config schema also has no `memory` owner, while the existing `searchMemoriesExternal` wrapper reads desktop settings internally; CLI recall therefore requires explicit config/dependency injection rather than direct wrapper reuse. |
| W6 `/memory search` missing        | **Still present**                       | `COGNIA_COMMANDS` registers only `list`, `add`, `show`, and `delete`; `memory-controller.ts` has no search controller or shared lower-level search use.                                                                                                                                                                                                                                                                                                                                                    |
| W7 no automatic memory maintenance | **Still present**                       | Neither `session-runner.ts` nor `session-context.ts` calls the memory extraction/decay/consolidation runtime after a successful turn. The only memory-related TUI runtime remains the manual CRUD controller.                                                                                                                                                                                                                                                                                              |
| W8 dormant snapshot version        | **Implemented**                         | `restoreSnapshot` throws `SnapshotVersionMismatchError` when `snapshot.version !== db.verno`; bootstrap preserves the incompatible file instead of restoring or overwriting it. Tests cover mismatch and quarantine.                                                                                                                                                                                                                                                                                       |
| W9 dead overlay variants           | **Still present**                       | `state/types.ts` still declares `kind: "slash"` and `kind: "files"`, while the current composer palettes are driven outside the overlay union. A positive-control search finds many active overlay kinds but no production construction or handling of these two variants.                                                                                                                                                                                                                                 |

Relevant primary files:

- [`cli/src/db/bootstrap.ts`](../../cli/src/db/bootstrap.ts) —
  `writeSnapshotAtomically`, `preserveUnsafeSnapshot`, `ensureCliDb`.
- [`cli/src/db/snapshot.ts`](../../cli/src/db/snapshot.ts) —
  `SnapshotParseResult`, `SnapshotVersionMismatchError`, `restoreSnapshot`.
- [`cli/src/agent/session-context.ts`](../../cli/src/agent/session-context.ts) —
  `ResolvedCliTurn`, `createCliContextAssembler`.
- [`cli/src/tui/runtime/memory-controller.ts`](../../cli/src/tui/runtime/memory-controller.ts) —
  current memory CRUD surface.

### 1.3 Performance findings

| ID                                        | Current status            | Current mechanism                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 highlight before truncation            | **Still present**         | `format/result-render.ts:renderResultLines` calls `highlightCode(text, ...)` on the full body, then computes `cap` and emits only the first `maxLines`. The original wasted-work ordering remains.                                                                                   |
| P2 fullscreen transcript has no windowing | **Still present**         | `TranscriptImpl` in live mode maps every `groupContextRuns(cells, ...)` row. `ScrollView` clips/scrolls the rendered column but does not virtualize the cell tree.                                                                                                                   |
| P3 eager command imports                  | **Still present**         | `cli/src/cli/index.ts` statically imports every top-level command, including chat and serve, before it can answer `--help`/`--version`. `tui/commands/index.ts` similarly imports every command cluster eagerly. The old benchmark was not re-run, but its source mechanism remains. |
| P4 diff collapsed/cap/cache               | **Partially implemented** | `DiffView` accepts `maxLines` and `PermissionOverlay` passes `12`, so uncapped approval rendering is fixed. `DiffView` is still not memoized, and every shown line calls `highlightDiffText`; the tool-card path can still render the full diff.                                     |
| P5 `CellView` memoization                 | **Still present**         | `Transcript` and `Footer` are memoized, but `CellView` is exported as a plain function. `applyVerbose` still creates a new cell object for tool/thinking cells.                                                                                                                      |
| Minor interval/cache concerns             | **Partially implemented** | Paced reveal is now keyed correctly, but `usePacedReveal` still makes the interval depend on `shown`, recreating it each tick. This is lower risk than the fixed cross-turn correctness bug.                                                                                         |

### 1.4 Resilience findings

| ID                               | Current status                                | Current mechanism                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 no TUI SIGTERM/SIGHUP cleanup | **Still present**                             | `renderTui` has a `finally` that restores paste/title/mouse/alt-screen, but it registers no SIGTERM or SIGHUP handler to drive `waitUntilExit()` to that `finally`. The serve path has explicit SIGINT/SIGTERM durability hooks; the TUI does not.                 |
| R2 catch can throw               | **Still present**                             | `turn-engine.ts:runTurn` still executes `const message = (err as Error).message`. A rejection with `null` or `undefined` throws inside the catch, before `TURN_ERROR`, reproducing the original wedge mechanism.                                                   |
| R3 async faults invisible in UI  | **Still present**                             | `installProcessCrashGuards` only calls `CrashLogger`. It deliberately prevents Node’s default termination but has no reducer/UI sink, so an async fault can be durable in a log while the current screen remains stuck.                                            |
| R4 app-wide error boundary       | **Mechanism present, but no verified defect** | `mount.tsx` wraps the entire `<App>` in one `AppErrorBoundary`, but the audit found no reproducible cell/overlay render fault that justifies multiplying recovery boundaries. Keep this as an observation, not completion work, until a local failure case exists. |
| R5 child-process error listeners | **Implemented**                               | Current async spawn sites such as `clipboard-image.ts`, `runtime/editor.ts`, and `agent/run-shell.ts` attach `error` listeners; `run-shell` also owns abort and process-tree cleanup.                                                                              |

### 1.5 Coverage findings

| ID                                 | Current status                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 no CLI-specific threshold       | **Still present**                                                  | `jest.config.ts` collects `cli/src/**/*.ts`, but `scripts/test/coverage-thresholds.json` contains no `./cli/**` threshold. CLI code only contributes to the low global floor.                                                                                                                                                                                                 |
| C2 TUI `.tsx` excluded             | **Still present by explicit policy**                               | The CLI collect glob is exactly `cli/src/**/*.ts`; its adjacent comment explicitly says TUI `.tsx` is not collected. This is no longer accidental, but it still does not satisfy the plan’s coverage contract.                                                                                                                                                                |
| C3 `AppOverlays` untested handlers | **Partially implemented**                                          | A substantial direct `components/app/AppOverlays.test.tsx` now exercises many overlay branches and callbacks, including logs and selection/confirmation flows. Because `.tsx` is not collected, there is still no enforced function-coverage proof for the whole switch.                                                                                                      |
| C4 `FormOverlay`                   | **Still present**                                                  | `components/overlays/FormOverlay.tsx` still has no co-located `FormOverlay.test.tsx`, and `.tsx` is outside collection.                                                                                                                                                                                                                                                       |
| C5 command dispatch                | **Implemented for co-location; coverage enforcement remains open** | `commands/dispatch.test.ts`, `index.test.ts`, registry tests, and per-command suites now cover the dispatch surface. A current source/test inventory across `cli/src/tui`, `agent`, `config`, `db`, and `serve` finds only `FormOverlay.tsx` without a same-name co-located test. Because `.tsx` is excluded from collection, C2/C4 still prevent an enforced coverage claim. |

## 2. 2026-07-16 parity and industry plan

| ID                                              | Current status                                                             | Source evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1 GitHub MCP required auth header              | **Still present**                                                          | `mcp/preset-catalog.ts:requiredFieldKeys` and `missingPresetFields` still exclude every `placement === "header"` field. `runtime/mcp-controller.ts:mcpPresets` duplicates the same split into “required non-header” and “optional header”, so GitHub’s header-only credential can still be omitted and the generated Add command still lacks it.                                                                                                                                                                                   |
| N2 hooks schema/loader/onboarding contradiction | **Still present**                                                          | `hooks/load-hooks.ts` reads `config.json.hooks`, and `hooks-controller.ts` tells users to add it. `config/schema.ts:cliConfigFileSchema` remains strict and defines only `builtinHookOverrides`, not `hooks`, so normal config resolution rejects the advertised key before the loader can use it.                                                                                                                                                                                                                                 |
| N3 no CLI sandbox                               | **Partially implemented; scope clarified**                                 | External agent processes now fail closed through `runtime/external/sandbox-launcher.ts` (macOS Seatbelt/Linux bubblewrap), and `/doctor`/backend connect report readiness. The built-in CLI does not project `activeProject` or sandbox settings into `resolveSendOptions`, so model-selected native `bash` misses the existing ADR-0028 sandbox/confinement path. Explicit user-entered `!command` is a separate trusted-local action unless product chooses otherwise; its lack of sandbox is not classified as the same defect. |
| N4 no TUI i18n                                  | **Still present**                                                          | TUI-facing `.tsx` and controller strings remain hard-coded English. `format/limits.ts` still notes that shared i18n keys are for the desktop renderer. `lib/headless/i18n.ts` already resolves messages from the shared `i18n/messages/{en,zh-CN}.json` catalogs, but the CLI has no locale precedence/persistence contract and does not inject that resolver into the TUI.                                                                                                                                                        |
| N5 GUI has no rewind                            | **Outside this CLI implementation audit; still a reverse-parity decision** | The TUI side is stronger than the plan’s baseline (`checkpoint-*`, `/rewind`, destructive edit/fork). No conclusion about the GUI implementation is inferred from `cli/`; the product decision remains separate.                                                                                                                                                                                                                                                                                                                   |
| N6 no ACP support                               | **Superseded / implemented as external-agent hosting**                     | `agent/external-agent-session.ts` maps ACP events, permissions, model/turn calls, sessions, and resumability. `cli/external-chat.integration.test.ts` drives an ACP fixture into TUI cells. Cognia is an ACP client/host of external agents; this does not by itself make `cognia-agent` an ACP agent distributable in the ACP Registry, which was the optional opposite direction in N6.                                                                                                                                          |
| N7 worktree isolation and cloud handoff         | **Split**                                                                  | Worktree isolation remains absent from `cli/src`. Local↔desktop handoff is implemented through `cli/handoff-cmd.ts`, `run --handoff`, chat `/handoff`, transcript drop files, and tests. It is not a hosted cloud execution service, but the original “no handoff affordance” claim is obsolete.                                                                                                                                                                                                                                   |
| N8 stale subsystem docs                         | **Still present and worse by drift**                                       | Both `docs/content/docs/{en,zh}/subsystems/cognia-agent-tui.mdx` still claim `~175` files, `45+` commands, 19 controllers, 14 overlays, and 13 chords, repeat the false all-pure-modules-have-tests claim, and describe `/team run` as desktop-only. Current source has grown again since the plan.                                                                                                                                                                                                                                |

## 3. 2026-07-24 external-backend remediation

### 3.1 Gap-by-gap status

| ID                                                | Current status                                | Production and test evidence                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 external sessions bypass canonical context     | **Implemented**                               | `agent/session-context.ts:createCliContextAssembler` owns project instructions, output style, mode, skills, tool policy, plugin/host manifests, MCP, attachments, twin context, roots, and context hashing. Both `session-runner.ts` and `external-agent-session.ts` consume it. `external-cognia-parity.test.ts` covers instructions, tools, permissions, attachments, twin context, and modes.                 |
| G2 external sessions cannot call Cognia built-ins | **Implemented**                               | `agent/tool-host/policy.ts` derives visible built-ins from effective `SendOptions`; `tool-host/broker.ts` rechecks visibility, confinement, and approval; `tool-host/spawn.ts` attaches the bridge. `bridge.integration.test.ts` spawns the real bridge process and exercises listing, authorization, execution/reporting, and rejection.                                                                        |
| G3 host/plugin tools stop at sidecar              | **Implemented**                               | `tool-host/host-tools.ts` reuses `makeCliPluginToolHandle`, which routes `ask_user`, `load_skill`, plugin/web tools, and `dispatch_agent` through existing CLI executors. `host-tools.test.ts`, broker tests, and external parity tests cover these paths and their special timeout/context behavior.                                                                                                            |
| G4 mutation semantics ambiguous                   | **Implemented**                               | `runtime/context-lifecycle.ts` explicitly classifies per-turn, live, and session-restart fields. `external-agent-session.ts:reconcile` closes/recreates the protocol session on `contextVersion` changes and emits `EXTERNAL_CONTEXT_RESTART`; `external-session-link.ts` refuses a mismatched persisted context.                                                                                                |
| G5 incomplete permission/sandbox boundary         | **Implemented for execution authority**       | The broker uses a random session token, owner-only socket path, attempt/context descriptor, discovery and call-time filtering, confinement roots, and the existing permission gate. Tokens travel in env rather than argv. External native tool requests still use the normal ACP gate, while projected Cognia namespaces are auto-acknowledged only at the agent layer and gated authoritatively in the broker. |
| G6 capability UI reports transport assumptions    | **Implemented**                               | `backend-capabilities.ts` combines negotiated MCP support with live `ToolHostStatus`; `backend-controller.ts` fails before the composer when a backend cannot host the bridge; `cognia-parity-report.ts`, `/status`, and `/doctor` report context version, tool counts, user MCP count, health, and restart-required fields.                                                                                     |
| G7 late registration race                         | **Implemented**                               | `runtime/backend-lifecycle.ts` owns monotonically increasing attempts, reclaims late results after cancellation/disposal, closes the session before disconnecting the process, serializes teardown, and is idempotent. `backend-lifecycle.test.ts` covers late registration, rapid replacement, double dispose, ordering, and settling-connect disposal.                                                         |
| G8 reveal and launch interaction                  | **Implemented for the specified regressions** | `usePacedReveal` accepts a turn epoch and resets before paint for shorter/rewritten streams; tests cover short second turns, append continuity, rewrite, and abort. `LaunchShell` is shared by startup/connect/install/failure; `launch-shell-layout.ts` budgets wrapped rows and preserves actionable body/hints at 40×12, 60×16, 80×24, and 120×40.                                                            |

### 3.2 Architecture now present

The source now matches the plan’s intended ownership model:

```text
createCliContextAssembler
  ├─ built-in mapper → sidecar SendOptions
  └─ external mapper → ACP/Codex session + turn
                         ├─ enabled user MCP servers
                         └─ authenticated Cognia MCP bridge
                              ├─ built-in handlers inside the strict sandbox
                              └─ broker-owned host/plugin/subagent/elicitation handlers
```

Key files:

- [`cli/src/agent/session-context.ts`](../../cli/src/agent/session-context.ts)
- [`cli/src/agent/external-agent-session.ts`](../../cli/src/agent/external-agent-session.ts)
- [`cli/src/agent/tool-host/broker.ts`](../../cli/src/agent/tool-host/broker.ts)
- [`cli/src/agent/tool-host/policy.ts`](../../cli/src/agent/tool-host/policy.ts)
- [`cli/src/agent/tool-host/host-tools.ts`](../../cli/src/agent/tool-host/host-tools.ts)
- [`cli/src/tui/runtime/backend-lifecycle.ts`](../../cli/src/tui/runtime/backend-lifecycle.ts)
- [`cli/src/tui/runtime/backend-capabilities.ts`](../../cli/src/tui/runtime/backend-capabilities.ts)

### 3.3 Remaining verification debt against the plan

The implementation and deterministic fixtures are strong. The repository also owns a real-agent
smoke:

- `scripts/smoke/external-cognia-parity-smoke.ts` drives Codex app-server, Codex ACP, and Claude
  Code ACP through the real manager, sandbox launcher, broker, and bridge;
- it requires one read-only tool, one mutating tool, one host tool, exactly one approval, and the
  expected file side effect;
- `package.json` exposes it as `pnpm smoke:external-parity`.

This audit did not run that smoke because it needs installed, authenticated vendor agents and
spends real tokens. Therefore the remaining statement is only that current-environment smoke
results were not collected here. The plan’s full repository gates (`test:coverage`, typecheck,
lint, i18n, build, CLI build) likewise cannot be inferred from source presence.

## 4. TUI design specs

### 4.1 Bottom-pane and turn-control spec

**Implemented.**

- `components/app/BottomRegion.tsx` composes the working/status region and composer/footer instead
  of overloading a single footer line.
- `BottomStatus.tsx` shows elapsed activity, active tool detail, queued `btw` steer messages, and
  double-Esc/backtrack state.
- `format/status-bar.ts:fitStatusSegments` drops lower-priority segments to fit terminal width.
- `state.steerQueue`, `use-steer-queue.ts`, and `runtime/driven-turns.ts` make steering visible and
  drain it at turn boundaries.
- Double-Esc has been **superseded by the more capable edit/fork spec**: it enters backtrack
  selection rather than merely copying the last message into the composer.

### 4.2 Transcript cursor, find, per-cell actions, and autosuggest spec

**Implemented for the designed core.**

- `navigation/transcript-cursor.ts` owns focus, matches, next/previous navigation, and focused-cell
  resolution.
- `hooks/useTranscriptCursor.ts`, `FindBar.tsx`, `TranscriptRegion.tsx`, and global-key handling wire
  Ctrl+F, query editing, movement, measurement, and viewport targeting.
- `input/autosuggest.ts` and `Input.tsx` implement end-of-line history ghost text with popup/mid-line
  suppression.
- Focused transcript cells can be copied or toggled through the global-key path; arbitrary tool
  output can also be opened via `/inspect`.
- Overlay/list windowing and panel scroll helpers now exist across `SelectList`, MCP, skills,
  agents, settings, doctor, and document views.

### 4.3 Edit/fork, OSC52 copy, and clear-screen spec

**Implemented.**

- `use-global-keys.ts` enters/moves/commits `BACKTRACK_*` selection.
- `App.tsx` calls `agent.forkConversationAt(...)` before resending the edited prompt.
- `useAgentSession.tsx:forkConversationAt` truncates cells and transcript, closes the old runtime,
  and mints a new session without rolling files back.
- `agent/transcript.ts:replaceTranscript` supplies the destructive JSONL rewrite.
- `clipboard.ts` provides OSC52 auto/always/never modes, tmux/screen wrapping, a byte cap, and
  explicit too-large results; settings expose both mode and cap.
- `/copy` supports reply index, `code`, `tool`, and `user`; rebindable `copyLast`/`copyLastUser`
  actions exist.
- Ctrl+L clears/repaints the screen without clearing conversation state (`App.test.tsx` pins the
  distinction from `/clear`).

### 4.4 Subagent live-rendering spec

**Implemented.**

- `agent/subagent-live-output.ts` holds live text/reasoning/tool state.
- `agent/subagent-background-tasks.ts` journals background runs.
- `runtime/agents-controller.ts`, `AgentsPanel.tsx`, and `AgentRunPage.tsx` expose running and
  settled runs, including live drill-in.
- The dispatch path and external tool-host path both register the current CLI subagent context,
  allowing `dispatch_agent` to appear in the same tree instead of becoming an invisible nested
  run.

## 5. Newly discovered current-state gaps

### NEW-1 — debounced snapshot write failures become unhandled rejections

**Delivery class:** fix now — resilience/durability.

`cli/src/db/bootstrap.ts:defaultSchedule` runs `void fn()` inside `setTimeout`. `scheduleFlush`
passes an async callback that awaits `flush()` without a catch. A write error (disk full,
permission change, fsync/rename failure) therefore becomes an unhandled rejection rather than a
reported persistence error.

In the TUI, `installProcessCrashGuards` logs that rejection and keeps the process alive, but has no
UI sink (the existing R3 gap). In the serve path, behavior depends on which durability wrapper
owns the flush, but this `ensureCliDb` scheduler remains independently callable by DB-backed CLI
features.

Required contract:

- catch scheduled-flush errors at the scheduler boundary;
- preserve the last good snapshot/temp/backup state;
- expose a durable error cell or operator error;
- preserve a dirty/error state so the next explicit or scheduled flush can retry; do not add a
  separate background retry system without evidence that it is needed.

### NEW-2 — a failed `dispose()` cannot be retried

**Delivery class:** fix now — durability.

`CliDbHandle.dispose` sets `disposed = true` before `await flush()`. If the final flush rejects,
the caller sees the first error, but every later `dispose()` returns immediately and cannot retry
the final persistence. The wrapper also clears the module cache only after successful
`handle.dispose()`, leaving a cached handle whose inner disposer is permanently marked done.

Required contract:

- mark disposal complete only after a successful final flush, or keep a retryable terminal error
  state;
- test a first failed final write followed by a successful retry;
- keep idempotence after success.

### NEW-3 — broker audit reports are not bound to an authorized call

**Delivery class:** optional audit-integrity hardening; no direct execution bypass found.

`tool-host/broker.ts:dispatch` authorizes `authorize` and `exec`, but the `report` branch accepts any
authenticated bridge-provided `name`, `ok`, and `summary`. It does not require that the name is in
the visible manifest, that an authorization for the same call occurred, or that a call identifier
matches an outstanding call. A compromised/stale authenticated bridge could therefore fabricate
or reorder TUI tool cells even though it still cannot execute a denied host tool through `exec`.

Required contract:

- mint a broker call id during authorization;
- require that id in the built-in bridge report;
- bind it to server/name/attempt/context version and consume it once;
- reject unknown, duplicate, stale, or mismatched reports.

This is defense-in-depth for TUI/audit integrity, not an execution-authority bypass and not a core
completion blocker. The authenticated bridge can currently fabricate display reports but cannot
use `report` to execute a denied tool.

## 6. Recommended next order

1. Fix N1 and N2 first. Both are small, deterministic, user-facing contract defects that can
   generate broken configuration from the product’s own instructions.
2. Fix NEW-1/NEW-2 with focused DB orchestration tests; they sit on the same durability boundary as
   the already-remediated W2/W8 data-loss work.
3. Decide and implement the model-selected native-shell half of N3. Do not confuse the completed
   external-agent sandbox or the trusted-local `!command` surface with model-tool confinement.
4. Define standalone CLI memory config ownership, then implement per-turn recall and search.
   Treat automatic extraction, maintenance, and synchronization as a separate consent/cost/PII
   proposal.
5. Rerun startup and long-transcript benchmarks. Apply only optimizations tied to measured
   regressions; gate transcript virtualization on a demonstrated interaction-budget failure.
6. Add TUI signal cleanup and null-safe `runTurn` terminalization before expanding crash recovery.
7. Establish explicit policy for TUI i18n and per-file CLI `.tsx` coverage; then update the stale
   bilingual subsystem docs with stable capability descriptions instead of volatile counts.
8. Treat broker report correlation as optional defense-in-depth. The real-agent conformance smoke
   already exists; run it in release verification when the required authenticated agents are
   available.

## 7. Bottom line

The old plans should not be executed wholesale. Their most ambitious work — external-agent Cognia
parity and the planned TUI interaction surface — is now real and well-tested at the module,
fixture, and repository-owned real-agent smoke levels. The verified core backlog is narrower: two
broken configuration contracts, memory recall/search, the native-shell boundary, coverage and
resilience debts, two newly identified durability defects, and one optional audit-integrity
hardening item. Worktree isolation and other deliberately unsupported capabilities are product
expansions, not completion defects.
