# Pi agent compatibility audit — 2026-10-05

## Version and scope

The npm registry and official release page report `@earendil-works/pi-coding-agent@1.0.2` as latest. The workstation's existing `pi` is `0.99.1`. Verification installed `1.0.2` into an isolated temporary directory; it did not replace the user's global installation or read their credentials.

Cognia's certified target is now **1.0.2**, while the compatibility minimum remains **0.85.1**. Other accepted versions are explicitly unverified. The install preset and distributable bundle pins now select `1.0.2`; the repository root dependency lock is unaffected by this upgrade.

This audit verifies Cognia's native Pi RPC integration and its surrounding configuration/import surfaces. It does not assert that every upstream Pi TUI command has a Cognia control, that every cloud provider has been tested, or that a packaged desktop/mobile release has been certified.

## Repaired behavior

| Area                      | Previous behavior                                                                     | Result                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Extension commands        | A handled command waited forever for an `agent_settled` event that Pi does not send   | Completes from `disposition: handled`                                                                                |
| Extension dialogs         | Dialogs before the prompt response could not reach the waiting consumer               | Events drain while acceptance is pending                                                                             |
| Dialog timeout            | A late response could revive a timed-out preflight without a consumer                 | Close the process, cancel pending dialogs and prevent reentry until cleanup finishes                                 |
| Cancellation              | `abort` could allow queued steering/follow-up work to continue                        | Clear the queue before aborting or closing                                                                           |
| Models                    | A bare model ID sent no provider, causing an upstream refusal                         | Resolve the active provider and persist the qualified selection                                                      |
| Tool streaming            | Serialized argument fragments had no call ID and were lost                            | Correlate content indices with start records; avoid duplicate starts                                                 |
| Usage                     | Repeated/resumed turns could report cumulative history as new usage; cost was omitted | Per-turn deltas, resume/fork baselines, provider cost                                                                |
| Compaction                | Native Pi custom instructions were not exposed                                        | Forward focus through the capability, hook, manager and native RPC path, with PII checks                             |
| Native MCP                | Configuration assumed Pi required a third-party MCP extension                         | Read/write native stdio and HTTP configuration, retain the existing persisted target ID and preserve Pi-owned fields |
| Unsupported MCP transport | Skipping an existing managed SSE entry could delete it before reporting failure       | Reject projection before writing and return a synchronization error; preserve the original file                      |
| MCP migration             | Pi's migration surface did not expose native MCP configuration                        | Route MCP to `mcp.json`, keeping `settings.json` separate                                                            |
| Settings import           | Valid `xhigh` and `max` settings were treated as unknown                              | Import supported effort levels; explicitly explain `off`/`minimal` representational limits                           |
| Session import            | Native cost objects, tool-result images and nested-call records were lost             | Preserve costs including zero, images and available nested-call metadata; report upstream truncation                 |

Steering and compaction focus were reviewed for outbound PII checks. Native and projected tool permissions remain separate: Cognia's broker authorizes projected tools; the bundled extension intercepts native and codemode-nested tools.

## Actual-process verification

The reusable harness is `scripts/smoke/deepseek-harness-adapter-smoke.ts`, built with the existing CLI bundler. Direct `tsx` execution is unsuitable for this mixed ESM/CommonJS graph; use the wrapper below.

```sh
rtk proxy env PATH="/tmp/cognia-pi-1.0.2-audit/node_modules/.bin:$PATH" node scripts/smoke/build-and-run-smoke.mjs --pi
rtk proxy env PATH="/tmp/cognia-pi-1.0.2-audit/node_modules/.bin:$PATH" node scripts/smoke/build-and-run-smoke.mjs --pi --sandbox
```

Both routes passed with the actual **Pi 1.0.2 process**, staged Cognia extension, Node host, CLI broker, renderer helper and actual sidecar. The second route uses the production host sandbox launcher on macOS. The model endpoint is a deterministic local HTTP/SSE fixture, so the test causes no cloud model charges and establishes protocol/host behavior independently of a provider's availability.

The run covers **7 sessions / 17 prompts**:

- Concurrent sessions and session-specific routing.
- Follow-on turns, disconnect/reconnect, persisted forks and resume with fresh MCP credentials/instructions.
- Extension commands handled without a model run, including a dialog before prompt acknowledgement.
- Read-only provider authentication diagnostics against fixture credentials.
- Model catalog, bare model selection and thinking-level clamping.
- Native plan-mode tool floor; rejected and approved native writes.
- Unicode JSONL containing U+2028, U+2029 and Chinese text.
- Codemode's nested native write, with both outer and nested approval gates observed.
- Clearing steering before cancellation; a subsequent turn succeeds without executing the queued input.
- CLI and renderer Cognia tools, user questions, extra directory access, denied writes, PreToolUse and PostToolUse hooks.

The isolated fixture explicitly enables `builtin:codemode`; the isolated extension policy intentionally disables discovery of the user's extension stack. This does not change the product's isolation default.

Additional validation used Pi 1.0.2's own `loadMcpConfig` to parse Cognia's projected MCP configuration and confirm trusted project overrides and untrusted-project isolation.

## Automated checks and evidence boundaries

- The combined selection contained **61 suites / 1,282 tests**. Its first run passed 1,275 tests; seven inspector tests failed because their fixtures lagged concurrent component changes. After adding the existing app's `TooltipProvider`, required instance props and the current accessible action name to the test fixture, all seven passed in a focused rerun. These figures represent distinct tests across the combined run and corrective rerun, not one uninterrupted all-green run.
- A final bounded run independently passed **386 runtime/hook/capability tests** after the timeout-cleanup fix. These are included in the 1,282 above, not additional tests.
- The bundled extension and staging tests passed **33 tests**, including real stdio/HTTP/SSE MCP fixtures, permissions, cancellation, PII and extension integrity.
- Rust `cargo test -p cognia-external-agent pi --lib` passed **26 tests**, with 234 tests filtered out. This is not a whole Rust workspace result.
- Focused ESLint, formatting and whitespace checks were run on the changes.

The initial full TypeScript run exhausted its default heap. A 16 GiB retry completed and exposed concurrent unrelated errors in external-agent configuration/state-isolation tests, account identity, plugin permission tests and push notifications. The Pi native-focus type error discovered in that run was corrected. A subsequent full retry was interrupted; a whole-repository green typecheck/build is not established.

One settings suite initially could not load because concurrent work imported a missing `duplicate-agent-dialog` component. That component subsequently appeared, but a retry of `external-agent-settings.test.tsx` exited without a passing summary amid repeated React `act` warnings; that suite remains unverified. Real-browser verification could not reach the Pi settings screen: Turbopack failed resolving a `next/dynamic` client reference; the webpack retry exhausted disk space while caching. A final browser retry was interrupted during compilation.

Running the large-heap typecheck and webpack browser build concurrently was excessive for the available resources and contributed to workstation pressure. After the user reported a freeze, no remaining audit-owned heavy process was found. Final checks ran sequentially with a 2–3 GiB Node heap and a 60-second process-group deadline where applicable. No full build or browser server was restarted. Shared caches, user accounts and unrelated work were preserved.

Some Pi Jest runs finish all assertions but retain open resources. The final bounded runtime run uses `--forceExit`; `--detectOpenHandles` did not identify a cause. This remains a test-process cleanup limitation, not evidence that the native process smoke hung.

The bundle-wide pin gate also reports unrelated missing runtime declarations for `kimi`, `qoder`, `aider` and `goose`. Pi's manifest/package/lock agree; no full multi-runtime bundle was built or published.

## Shared capability implementation — follow-up on 2026-10-05

The previously uncovered RPC features now extend the common adapter and manager contracts before implementation in Pi. The manager/settings panel and chat session panel reuse one `ExternalAgentSessionOperations` component. Unsupported runtimes hide unavailable controls; unknown runtime state is not displayed as a guessed default.

| Common capability      | Pi implementation and consumer                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured live input  | Steering and follow-up text/images; command acceptance preserves `queued` versus `handled`                                                              |
| Queue management       | Clear both queues, restore cancelled text/images through existing composer intents, configure all/one-at-a-time policies                                |
| Runtime settings       | Query state, control automatic compaction/retry and abort retry                                                                                         |
| Commands               | Refresh advertised commands, accept arguments, permit explicitly advertised extension commands during an active turn                                    |
| Native history         | Raw entry/tree query, user-entry fork, full clone, session rename, runtime-created HTML export                                                          |
| Direct shell           | Shared permission callback/hooks, include/exclude context, output/exit/cancel/truncation state, preflight-safe cancellation                             |
| Extension presentation | Shared status/widgets/title/editor/notification events rendered by desktop and CLI; snapshots hydrate late subscribers and resumed sessions             |
| Background turns       | Explicitly advertised capability, structured user/assistant/tool delivery after handled commands, session-owned broker lease, Stop and decision cleanup |
| Native chat identity   | Existing transient runtime store links each local chat to its latest native session, including fork/clone, without rewriting persisted gateway routing  |

Pi's first-result `user_bash` dispatch requires a separate first-loaded guard. The guard and the main extension (last among explicit `-e` arguments) are both pinned and verified by Node/Rust hosts. The compiled standalone package preserves the same verification contract. Shell capability requires a verified host guard path plus handshake; arbitrary metadata cannot enable it. Output redaction occurs before Pi appends the shell result to model context, including cross-chunk sensitive values; output is bounded to the latest 16 KiB and carries truncation state. Pi's configured shell path is preserved.

Focused follow-up verification (separate bounded runs):

- Final common capabilities/protocol/manager/runtime-store/controller selection: 5 suites / 353 tests passed.
- Native link store/controller/CLI/manager integration: 393 tests passed in the earlier link-wiring batch. The public chat hook's external-flow selection separately passed 29 tests (305 unrelated tests filtered out).
- Three mounted-controller regressions passed: retain broker across handled ACK and pause on native-link change; Stop cancels the exact native session after the owned send ends; early background events wait for owned persistence and preserve both replies.
- Final shared controls, commands, manager, session panel, chat view and Node integrity verifier: 6 suites / 206 tests passed, including idle commands using the owning chat send path.
- Final CLI session/event mapper/reducer/useAgentSession and desktop external hook: 5 suites / 545 tests passed. These include user/assistant/tool persistence, owned-user echo suppression, immediate ACK buffering, Stop, and explicit background broker lease retention/teardown. Final ESLint on these seven sources passed with no warnings.
- Shared extension UI and Pi event normalization were also checked in a 3-suite / 122-test batch; composer session/IME/empty-editor cases passed a focused 3-test selection. These overlap later hook checks.
- Bundled Pi main extension and first-loaded guard: 25 tests passed.
- Standalone extension staging and host package verification: 30 tests passed, including missing/substituted guard rejection and importing the staged guard with no local `node_modules`.
- Desktop sidecar resource closure: 14 tests passed.
- Rust host verifier: 10 tests passed (`cargo test -p cognia-sidecar pi_extension --lib -j 1`).

These batches overlap earlier audit checks and must not be summed into a distinct-test total. The final Pi client run passed 194 tests. The expanded actual Pi `1.0.2` run through the production macOS sandbox passed **9 sessions / 21 prompts**. In addition to the initial matrix above, it verifies entries/tree/entry fork/clone/rename/HTML export, queue policies/runtime controls/retry abort, live extension commands, multimodal queue restoration, extension UI presentation, and direct-shell approval/denial/redaction/cancellation. A configured extension deliberately attempts to intercept `user_bash`; the first-loaded verified guard prevents that override. Pi's native SDK shell configuration loads successfully inside the staged sandbox. A handled extension command also starts a real Cognia projected read-tool call through the renderer helper and approval hooks. The harness owns that renderer lease directly; controller lease retention is separately covered by controller regressions.

A real-process regression established that `pi.sendUserMessage` may start its model run **after** a handled command's acknowledgement. The adapter now transfers subsequent events to its idle subscription at terminal delivery rather than dropping them behind the closed command iterator. Shared event consumers distinguish this out-of-band delivery from normal execution, and the smoke asserts the resulting model output. This is an actual process ordering check, not only a mocked event sequence.

The follow-up stayed serial with bounded Node heaps. An attempted narrowed TypeScript program still expanded into the full shared graph and exhausted a 2 GiB heap; no successful whole-repository typecheck is claimed. No production build, browser development server or real desktop UI was relaunched. Focused ESLint, source formatting, i18n generation/freshness/key parity and scoped whitespace checks passed. Some hook suites still emit overlapping React `act()` warnings; these assertions pass, but that is not a warning-free whole-app test claim.

The entry inspector preserves complete normalized entry objects, including non-message metadata, rather than displaying only user/assistant text. Its final focused component suite passed all 10 tests, with focused ESLint also passing. Nine of those tests overlap the earlier 206-test UI batch.

## Explicit support limits

- Upstream TUI-only facilities such as arbitrary extension custom TUI rendering are not representable by the RPC extension UI protocol. Supported structured RPC UI methods are rendered through the common presentation contract.
- Native Pi MCP configuration supports stdio and streamable HTTP. The Cognia-hosted extension still supports SSE MCP servers through its own SDK projection; these are distinct configuration routes.
- Cognia's `defaultEffort` has no `off` or `minimal` value. Import reports that limitation rather than silently enabling or changing reasoning.
- Pi records nested-call metadata, not nested results. Missing results cannot be reconstructed. Imported chat messages preserve tool-result images; the canonical export codec explicitly reports omission of inline image bodies.
- No real paid-provider turn, OAuth login/refresh, remote paired host, mobile device, Linux sandbox, or packaged application was tested here. Authentication probes used isolated fixture credentials and `--no-refresh`.

## Sources

- [Official Pi 1.0.2 release](https://github.com/earendil-works/pi/releases/tag/v1.0.2)
- [Versioned RPC protocol](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/rpc.md)
- [Versioned RPC commands](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/rpc-commands.md)
- [Versioned JSON event stream](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/json.md)
- [Native MCP configuration](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/mcp.md)
- [Codemode and nested tool behavior](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/codemode.md)

All installed package contracts were inspected at the exact `1.0.2` version; no assumptions were based solely on an unversioned documentation page.
