# DSH integration audit — 2026-10-20

## Scope

Inspect DSH context capacity, usage accounting, native/gateway reasoning options,
SDK/ACP launch configuration, and the existing host integration. Preserve other
work in the shared checkout. Typecheck was explicitly skipped at the user's
request; no further application build was performed.

## Corrections

1. Translate the root SDK `request/context.contextWindow` into safe session
   metadata and attach it to committed and final usage. Retain capacity across
   turns, replace/clear it on model changes, and ignore descendant capacity.
   Request contents are not exposed as metadata.
2. Resolve the composer's capacity from the active Cognia model binding and its
   configured provider metadata. Match the gateway's
   `min(contextLength, maxInputTokens)` rule. A newly selected model takes
   precedence over old reply metadata; an unknown binding displays unknown.
   Native model catalogs remain the fallback before runtime reporting.
3. Keep cumulative billed token counts separate from the latest measured
   committed request's context occupancy. Failed attempts do not replace that
   measurement. Mark DSH aggregate prompt counts as including cache so conversion
   to renderer input/cache buckets does not double-count cached tokens. Other
   channels retain their existing conversion semantics. Apply the same rule to
   CLI turn results and persisted transcript metadata, whose separate mapper
   otherwise still double-counted the cache.
4. Normalize generic reasoning tiers for native DeepSeek requests:
   `minimal/medium -> low`, `xhigh -> high`, `ultracode -> max`. Preserve native
   `off/low/high/max` and gateway model-specific tiers. Cover SDK creation,
   prompt dispatch, transport configuration, and managed launch construction.
5. Make the ACP native composition consume the configured reasoning effort and
   maximum output tokens. The runtime test checks the actual captured provider
   request (`low`, `1234`) rather than environment variables alone.
6. Retain the last measured context occupancy when a later committed message
   carries empty or partial usage. Direct prompt-stream tests cover absent,
   empty, input-only, and output-only usage; three failed before this correction.

## Validation

| Evidence                                 | Result                        | Boundary                                                                                     |
| ---------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Final focused Jest run                   | 13 suites, 635 tests passed   | DSH package, model binding, context indicator, toolbar, gateway/session integration          |
| External token accounting regressions    | 2 tests passed                | DSH cache/occupancy conversion and unchanged legacy semantics                                |
| Launcher and actual runtime tests        | 17 passed                     | Current compositions and SDK/ACP request options                                             |
| Native adapter smoke                     | Passed; 5 sessions, 7 prompts | Real DSH runtime and Cognia host/adapter/broker/renderer helper/sidecar; local mock provider |
| Gateway adapter smoke                    | Passed; 5 sessions, 7 prompts | Same integration, Cognia gateway route; local mock provider                                  |
| Live configured `dsh headless`           | Passed                        | Actual provider returned `COGNIA_DSH_LIVE_AUDIT_OK`                                          |
| Live persisted CLI session follow-up     | Passed                        | Same session returned `COGNIA_DSH_LIVE_AUDIT_OK_FOLLOWUP`                                    |
| Scoped ESLint, Prettier, diff whitespace | Passed                        | Task files only                                                                              |
| Independent browser context display      | Passed earlier in this task   | DeepSeek Flash 1M, GPT-4o 128K, unknown capacity shown as unknown                            |

Both adapter smoke runs exercised tool results, broker/renderer approval routing,
additional workspace roots, denied writes, and reconnection. The native run also
asserted that generic `medium` reached the mock provider as `low`.

A broader run including the complete shared `lib/claude/usage.test.ts` suite had
607 passing tests and one existing catalog-parity failure: `claude-haiku-5-5`
declares 1,000,000 tokens in the catalog while the legacy pattern resolver returns
200,000. The DSH-specific accounting tests pass independently; the unrelated
catalog mismatch was not changed.

The CLI session suite also ran: 111 tests passed and the existing startup test
`reserves turn startup before allowing an MCP apply` failed with
`TypeError: release is not a function` before reaching usage conversion. A
separate run excluding that test produced 111 passing assertions, including the
two new CLI turn/transcript regressions, but retained open handles after Jest's
summary. These CLI runs are not counted as a clean, fully passing suite.

## Cross-model review

A live DSH headless review received the task source diffs via stdin, with an OS
sandbox denying writes to the project tree. It identified the partial-usage
occupancy reset, which was reproduced and corrected above. The remaining
findings were reconciled against source outside the extracted diff: the toolbar
passes the new capacity/source props; descendant filtering precedes aggregation;
managed ACP launch normalizes its environment; the unknown ring uses guarded
custom rendering; the supported app effort tiers have explicit mappings; and
launch environments are rebuilt from an allowlist rather than reused. Direct,
manually inconsistent launch configurations were not treated as managed-path
regressions. A subsequent local read-only review found no regression in either
late fix.

## Limits and activation

- The live CLI calls confirm actual provider availability and CLI persistence;
  the Cognia adapter smoke tests use a local mock provider. These are separate
  evidence layers.
- The previously running Tauri debug process exited. No fresh native GUI
  acceptance was claimed after that exit, and no Rust rebuild was started.
- The ACP composition source is corrected. The installed runtime was subsequently
  repaired through the normal settings flow; see the follow-up below.
- SDK persistent resume and live token deltas remain unsupported by Cognia's
  advertised DSH SDK capabilities. ACP does not advertise usage reporting.
- When a later committed message omits complete usage, occupancy remains the
  latest available measured value. It is not a measurement of that unreported
  request.
- No full typecheck, coverage run, or commit was performed for this continuation.

## Installed runtime repair follow-up

The normal Settings -> Agents -> Runtimes & installs -> Reinstall flow completed
against the installed desktop runtime on 2026-10-20. Upstream remains pinned to
`0.2.1-rc.2`; the activated channel is `dsh-0.2.1-rc.2-88ee4793`.

- All five installed runtime artifacts match the checked-out sources.
- Recomputed lockfile and composition digests match the activated manifest.
- Existing runtime-home data was backed up and restored; all three pre-existing
  regular files match their backup bytes. The backup remains task-local.
- The real Tauri window showed the selected DeepSeek Flash capacity as
  1,000,000 tokens, but the SDK/ACP model-switch acceptance matrix is still
  pending. That observation used an existing conversation and is not a new
  model request after the repair.

Live acceptance was interrupted by multiple tasks sharing the same managed
debug session. The session identity and owning process changed during this
task's operations. Process metadata identified a different task as the owner of
the replacement launch. The extra frontend used by this task was stopped; no
successful SDK/ACP model-switch acceptance is claimed from the interrupted
flows. The user subsequently deferred this task's UI verification; further
window interaction and restarts were stopped. SDK/ACP model-switch acceptance
remains pending. No typecheck was run.
