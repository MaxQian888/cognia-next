# @cognia/agent-omp

Independent Oh My Pi integration for Cognia's extracted agent architecture (ADR-0217). The package targets **OMP 18.6.1**, verified against the official release on **2026-10-06**. It is not registered in the application, CLI, runtime catalog, security policy, migration registry, or session discovery registry.

## Boundaries

Production code imports only `@cognia/agent-contracts` and `@cognia/agent-runtime-kit`. It reuses the adapter base, host process contract, outbound gate, LF framing, and neutral history contracts. It does not import Pi, the OMP SDK, Bun, React, Tauri, Node filesystem/process APIs, app aliases, stores, or orchestration. Node APIs in `scripts/` provide independent packaging and process tests only.

- `manifest`: protocol/ecosystem/runtime declarations, capabilities and execution semantics. These are declarations, not host authorization or conformance certification.
- `wire`, `rpc-peer`: all 60 versioned RPC commands, response types, v2 negotiation, bounded JSONL/chunk framing, UTF-8 validation, request IDs and separate prompt admission/completion.
- `rpc-client`: per-session process ownership, verified guard handshake, lifecycle, streamed events, cancellation, native-file resume, fork and the `omp.rpc` adapter extension.
- `session-client`: named typed methods for the entire upstream command surface. No untyped command escape hatch.
- `session-operations`: existing Cognia optional capabilities projected onto native OMP operations.
- `rpc-events`, `host-requests`: canonical event projection, native event observers, correlated tool/URI callbacks, scoped dialog IDs, cancellation and deadlines.
- `native-guard`: a pure extension factory for native tools, result redaction, direct shell/Python interception, provider payload transformation and rebinding handshakes.
- `history`, `config`: pure native-history parsing and configuration/profile projection; hosts retain discovery, IO, credentials and persistence.

The vendored wire definitions retain the upstream MIT license in `THIRD_PARTY_LICENSES`. Cognia package code follows the repository's AGPL-3.0-only license.

## Required host composition

Construct `OmpRpcClientAdapter` with an `AgentProcessHost`, mandatory `AgentOutboundGate`, runtime probe, and `prepareSession` callback. The callback receives the full `SessionCreateOptions` and an optional authorized resume file. It must prepare an isolated state/configuration root, project system/developer instructions, selected models, MCP settings and permission policy, stage an integrity-verified trusted extension, and return its absolute path, nonce, working/session directories and environment. `resolveLaunchEnvironment` can reuse the host's existing account/environment resolver.

The package launches only `--mode rpc --session-dir … --trusted-extension …`, with `--resume …` when needed. It deliberately does not reinterpret arbitrary application process arguments or use Pi's flags. OMP resolves CLI system prompts as text **or file paths**, so instruction projection belongs in the trusted preparation step. Prepare callbacks must not silently ignore requested options. Unsupported per-turn instruction/binding changes are rejected; prepare a new session instead.

`createOmpNativeGuard` requires injected authorization, output redaction, synchronous outbound transformation, and synchronous termination/egress revocation. The host must attest all three enforcement conditions:

1. The trusted extension is isolated from unreviewed extension code.
2. Provider egress cannot bypass the host's policy, including descendant/background work.
3. The guard is rebound across native session/subagent contexts and uses the correct account and session scope.

These booleans are host assertions, not a sandbox the package creates. In particular, OMP catches errors from some hooks: throwing from `before_provider_request` does **not** stop the original request. A guard failure returns a replacement payload and calls the host's synchronous termination/revocation callback. Do not wire that callback to an unawaited asynchronous process kill. Direct Bash/Python shortcuts return explicit denial replacements unless the host provides an authorized executor. Maintain the upstream hook deadline at least 30 seconds; guard callbacks have bounded deadlines below that limit.

Host tools and URI callbacks are optional injected brokers. They must authorize each request and honor cancellation; all outbound results additionally pass the mandatory gate. Registering a host tool does not authorize OMP-native tools. Native permission UI is handled by the guard broker; the adapter does not treat extension confirmation dialogs as tool permission grants.

`release` runs only after process termination is confirmed. A failed kill or release retains a quarantined handle for retry; retrying release does not kill a confirmed-dead process again. The host must terminate the process group, including descendants, within its own bounded deadline.

## Session and event semantics

- Prompt ACK means admission. Completion belongs to the matching `prompt_result`; `agent_end` can precede background work. A local command with `agentInvoked:false` completes without an invented model turn.
- `session_settled` controls quiescence. Session subscriptions stay alive after a prompt finishes.
- Cancellation terminates the dedicated process and invalidates the live session. `resumeSession` launches a new process using a known native file. Disconnect clears cached resume identities so another account cannot inherit them.
- Fork creates a separate guarded process, preserving the source session and its permission/instruction options unless explicitly overridden. The typed native `fork`/`branch` controls intentionally change the addressed native session. Cognia and OMP session IDs remain distinct.
- Transition adoption refreshes native identity and file together; stale state reads cannot overwrite the new locator. The verified transition handshake expires old dialogs and aborts old host work, with generation-scoped approval IDs. Same-session open and cancelled transitions do not require a nonexistent new startup event.
- Locally rejected, unsent transitions preserve the original process. Errors with uncertain native side effects retire it.
- One canonical prompt owns its stream at a time; steering/follow-up remain separate controls. Native `abortAndPrompt` replaces a native prompt ticket. Consumers must keep the replacement ticket and consume its completion.
- Delegated shell abort also retires the process: upstream `abort_bash` cannot interrupt an executor running inside `user_bash`. Host release must cancel any executor it owns outside the OMP process.
- Stream buffering is bounded by both count and bytes. Overflow, incomplete/malformed framing, lost processes and uncertain prompt timeouts fail the operation; prompts are not replayed automatically.
- Turn usage is a delta of native session statistics. Session totals and context occupancy remain separate.
- Queue removal is confirmed item-by-item because OMP has no atomic clear command. Partial removal must be inspected through `OmpQueueClearError`. The wire queue exposes text without attachment identity; image restoration therefore raises an explicit provenance error carrying confirmed removals and the original attachment candidates, rather than guessing which duplicate text owned an image.

The adapter owns negotiation and requires an unfiltered event stream; its typed facade rejects controls that would invalidate those guarantees. Lower-level `OmpRpcPeer` supports the complete wire surface for hosts that explicitly own those responsibilities.

## Advanced and platform-specific operations

The typed facade covers subagent subscription/messages/cancel/steer, goal/todo, handoff, host URI schemes, fast mode/cache warming, login, live voice, and word prediction. Raw typed events preserve vendor details that do not fit a shared Cognia event. This package does not create a second scheduler or claim that a device UI is connected. Live audio belongs to the machine executing OMP and requires a separately approved host/device integration.

Native history accepts JSONL plus optional host-read blob data and a required redactor. It handles the OMP title slot, versioned session DAG, active/alternate branches, tool messages, images, goals, todos and usage. Unsupported or malformed data is represented by bounded loss records rather than fabricated content. Filesystem scanning, database conversion and migration writes remain host responsibilities.

## Verification

From the repository root, use the installed binaries directly (avoids changing the shared workspace installation):

```sh
rtk proxy node_modules/.bin/jest --config packages/agent-omp/jest.config.cjs --runInBand
rtk proxy node_modules/.bin/tsc -p packages/agent-omp/tsconfig.json --noEmit
rtk proxy node packages/agent-omp/scripts/pack-test.mjs
rtk proxy env OMP_BINARY=/absolute/path/to/omp-darwin-arm64 node packages/agent-omp/scripts/process-smoke.mjs
rtk proxy env OMP_BINARY=/absolute/path/to/omp-darwin-arm64 node packages/agent-omp/scripts/controls-smoke.mjs
```

`pack-test` builds OMP, builds sibling dependency artifacts exclusively in a temporary directory, packs and installs offline with scripts disabled, checks every ESM/CJS export, strict NodeNext consumers and pure data import closures. It never installs the workspace or rewrites sibling manifests.

Use `OMP_KEEP_PACKED=1` to retain its isolated consumer. When workspace sibling builds are stale, set `OMP_PACKAGE_ROOT` to that consumer's `node_modules/@cognia/agent-omp` for live testing. `OMP_EXTENDED=1` adds real image, handoff, compaction, history export and native subagent assertions. The credential still enters only through stdin.

`controls-smoke` exercises actual native model/settings controls, extension dialogs, host URI/tool execution, shell allow/deny, goals/todos, queue operations, provider failure/recovery, subagents, and an isolated local ngram daemon. Its synthetic provider controls fault timing. The [60-command acceptance matrix](validation/rpc-acceptance-matrix.md) records positive behavior, boundary-only checks and remaining prerequisites separately.

`process-smoke` requires the official SHA256-pinned darwin-arm64 18.6.1 binary. It uses a temporary HOME/workspace, synthetic data, a loopback model fixture and macOS Seatbelt network restrictions. It verifies v2/chunks, native commands/queues/todos/history/transitions, guard binding and shell denial, plus adapter streaming, in-flight cancellation, resume and cleanup. That fixture test does not establish real provider, cross-platform, device-audio or application acceptance. The separate `scripts/provider-smoke.mjs` performs live DeepSeek testing with a credential supplied only through stdin and an `OMP_BINARY` path; it forwards actual API responses and removes temporary state. See [live acceptance evidence](validation/deepseek-2026-10-06.md).

### Verified on 2026-10-06

| Check                                  | Result                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Package unit/regression tests          | 13 suites, 119 tests passed                                                                      |
| Package TypeScript, ESLint, formatting | Passed                                                                                           |
| Build and isolated pack consumption    | 14 ESM/CJS exports, strict NodeNext consumers, 4 pure import closures, 7 offline tarballs passed |
| Official OMP 18.6.1 process            | 23 checks passed, 5 synthetic loopback model requests                                            |
| Extended native OMP controls           | 26 groups passed, 57 synthetic loopback model requests                                           |
| DeepSeek `deepseek-flash`              | Extended live run passed all 16 checks, including image, compaction, handoff and native subagent |
| Application/device integration         | Not performed; awaits approval                                                                   |

## Integration approval boundary

Before product integration, review the host preparation/guard broker, account isolation, descendant sandbox/egress enforcement, catalog/security registration, shared UI/CLI exposure, session discovery and migration wiring. Those changes are deliberately outside this package and require the user's next approval. Root package dependencies, generated registries and existing adapters are not part of this implementation.

## Sources

- [OMP 18.6.1 release](https://github.com/can1357/oh-my-pi/releases/tag/v18.6.1)
- [Versioned RPC documentation](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/rpc.md)
- [Versioned upstream source](https://github.com/can1357/oh-my-pi/tree/v18.6.1/packages/coding-agent/src)
