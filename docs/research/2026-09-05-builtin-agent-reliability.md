# Built-in CLI agent reliability — 2026-09-05

This implementation extends the existing CLI context assembler, sidecar tool
registry, permission resolver, canonical events, and OS sandbox. It does not
introduce another agent loop or a parallel tool protocol.

## Confirmed failures and changes

| Boundary                | Failure                                                                                 | Change                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLI configuration       | Desktop defaults disabled coding services                                               | CLI defaults enable process, shell, terminal, LSP, CodeGraph and AST tools; explicit configuration remains authoritative                  |
| Workspace autonomy      | `acceptEdits` rejected directory operations and sandbox write aliases                   | First-party aliases share existing permission rules, with denies evaluated before automatic approval                                      |
| LSP host                | Project configuration returned early outside Tauri                                      | CLI injects a Node reader and its managed installation directory; network policy controls automatic installation                          |
| Packaged AST search     | Bundled resolver could not find the installed optional binary                           | Resolve optional packages relative to their parent and stage the target binary in CLI distributions                                       |
| Tool relay startup      | Subscription failure was swallowed                                                      | Fail the turn with a structured startup error, shut down partial initialization, and allow retry                                          |
| Canonical events        | Tool summaries were downgraded to suppressed diagnostics; capture narrowed other events | Preserve canonical events through capture and CLI envelopes, fence sessions/turns, and drain terminal events before unsubscribing         |
| Permission cancellation | Late async pre-checks could reopen a prompt                                             | Cancel settles queued and pending checks; late decisions cannot authorize another turn                                                    |
| Live permission mode    | UI changed before SDK acknowledgment                                                    | Use the existing acknowledged control response and update effective mode only after success                                               |
| Readiness               | Built-in features were reported as unconditionally supported                            | Project resolved runtime capabilities and publish disabled/initializing/ready/failed tool-host status with reasons                        |
| CLI presentation        | Non-IM sessions were assumed to have an artifact dock                                   | Withhold dock tools, associated rules, and prompt guidance from the standalone CLI                                                        |
| Restart history         | Restored transcript was displayed but omitted from the next provider request            | Persist native SDK session identity or the AI SDK message snapshot, validate restoration, and restore through existing runtime interfaces |
| Native temporary files  | One-shot sandbox granted writes throughout the shared temporary directory               | Allocate a private scratch directory per invocation and expose only that directory to the child                                           |

Native processes reuse the existing sandbox launcher. Background processes and
persistent terminals retain session ownership and cleanup; child environments
exclude provider credentials and loader injection variables. Out-of-root writes
and disallowed network access are checked at the executor boundary.

The packaged runs exposed two additional dependency failures: a non-executable
`node-pty` spawn helper and AI SDK 7 response getters discarded by object
spreading. The PTY loader repairs helper permissions or reports how to recover;
the adapter explicitly forwards result getters and reads `responseMessages`,
preserving tool history and usage instead of retaining only assistant text.

A later rebuild also exposed a concurrent Canvas change importing `lib0/buffer`
without a direct dependency. Declaring the already-locked dependency restored
140 plugin tools in the same bundle. The CLI now rejects a failed plugin
bootstrap before sending a provider request, includes the underlying repair
reason, and evicts failed initialization from the cache so retry can recover.
The context/plugin/session regression run passed 109 tests.

## Acceptance evidence and limits

The packaged scripted-provider test is
`cli/src/cli/coding-loop.bundle.test.ts`. It drives the actual bundled CLI against
a local provider endpoint, fragments tool arguments, edits a real disposable
workspace, deliberately fails a Node test, repairs the file, runs the passing
test, and verifies the final summary. It also exercises CodeGraph, AST search,
and an injected stdio LSP server without installing dependencies over the
network. The fixture verifies physical filesystem and network effects rather
than accepting an assistant's claim that a tool succeeded.

The final fully bundled CLI and bundled sidecar run passed all six acceptance
cases in 55.1 seconds, covering both runtimes. Each rail completed the coding
loop above, background output, and directory creation/move. Separate cases
verified real terminal spawn/write/read/kill and real PTY restart: the next
provider request contained the original user request and tool output, followed
by a successful live follow-up turn. No source-sidecar override was used. The
sandbox helper override selected the actual rebuilt Rust executable in
`target/debug/cognia-sandbox-exec`; this is not a release-installer validation.
The expanded PTY cases also verified actual approval overlays without `--allow`:
four separately scoped approvals on AI SDK and five on the native runtime,
including Enter after the overlay remained mounted through rerenders. Both
cases required actual terminal output after approval, not just a UI state change.

Focused validation includes 247 passing protocol/capture/relay/TUI tests,
47 passing LSP client/service tests, and 36 passing isolated Cargo tests against
the repository's sandbox and launcher sources. The isolated Cargo run does not
substitute for a complete Tauri build. These groups overlap other targeted runs
and should not be added into a repository-wide test total.

A real stdio scripted-provider control test also exercises acknowledged Plan
transitions, read-only enforcement, invalid mode rejection, `ask_user`, approval
and denial, and interruption followed by a late approval. Runtime selection,
capability projection, and session restoration passed a focused 110-test run.
Persisted approvals are read again at each permission request in CLI and TUI;
revoking a grant therefore affects an already-running session. Explicitly
configured suppression remains separate from mutable persisted grants.
The approval queue retains its identity across App rerenders while reading the
latest grant resolver; otherwise opening the overlay could replace the queue
and leave Enter unable to settle the waiting tool. The final App/hook regression
run passed 156 tests.

The readiness module passed its explicit 90% gate: 98.55% lines, 95.58%
branches, and 100% functions. This is not a claim that repository-wide coverage
passed.

Repository-wide verification remains unsuccessful in the shared working tree:

- Full TypeScript checking completed with 661 diagnostics, including unrelated
  team/fleet changes and existing test fixtures. Earlier attempts exhausted the
  configured heap. Introduced local fixture errors were corrected.
- `pnpm test:coverage` encountered unrelated UI/team failures and then `ENOSPC`.
  The owned run was stopped. Stale generated CLI chunks were cleaned and rebuilt
  to recover disk space; shared source changes were preserved.
- `i18n:build:check` found trailing commas in the existing English and Chinese
  `agentRuns.json` split sources. `lint:i18n` reported 15 missing fleet keys.
  This change does not edit those translations.
- A configured DeepSeek smoke request returned `Insufficient Balance`. No live
  provider success or production-provider parity is claimed.

An approval cannot enlarge an immutable sandbox root ceiling. Out-of-root calls
must explain how to configure the required root and retry, rather than present
an approval that the executor cannot honor. Per-call temporary root elevation
and OS network allowlists are not implemented; unsupported network policies
fail with a recovery instruction. Linux and Windows runtime behavior require
their own platform acceptance runs.

The remaining scoped-elevation work requires both file and process boundaries
to consume a verified per-call grant tied to the workspace and turn. For network
allowlists, the existing captured-command sandbox owns a filtering proxy until
the child exits, whereas the persistent stdio launcher uses `exec()` and cannot
retain that proxy owner. Supporting it requires a proxy lease or supervising
launcher with tested signal and PTY lifecycle behavior. The CLI currently
reports this limitation and fails closed.

## Behavioral references

- [Claude Code permissions](https://code.claude.com/docs/en/permissions): scoped
  grants, deny precedence, and workspace edits.
- [Codex security](https://learn.chatgpt.com/docs/security): executor sandbox and
  approval boundaries.
- [OpenCode permissions](https://opencode.ai/docs/permissions/): operation and
  resource permission configuration.

These references informed the boundaries; they are not evidence that Cognia has
achieved complete feature parity with those products.

## External TUI follow-up — 2026-09-05

A follow-up audit reproduced failures in the external-session boundary, Pi RPC
responses, and transcript reducer. The working tree already contained the
built-in changes described above; the findings below were tested against that
baseline rather than attributed to a new implementation of the agent loop.

| Boundary                  | Reproduced defect                                                                                                                               | Repair                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Hosted-tool approval      | The idle watchdog stayed armed during broker approval, unlike native-agent approval; a 150 ms decision with a 30 ms idle budget failed the turn | Pause the same watchdog around broker decisions                                                                            |
| Turn cancellation         | A delayed approval could authorize after cancellation; delayed text still reached the UI                                                        | Reject obsolete decisions and ignore events after the turn is cancelled or finished                                        |
| Hosted-tool events        | Envelope-only consumers received assistant text and usage but no hosted tool calls/results                                                      | Route hosted calls through the active turn's canonical emitter, preserving legacy consumers                                |
| Transcript order          | A finished concurrent tool could overtake an earlier running tool; thinking, notices and later output changed order at commit                   | Commit only a completed prefix and retain later cells in arrival order                                                     |
| Pi dialogs                | A confirmation answer of `false` was converted to `true`; stale replies and cancellation did not consistently close pending dialogs             | Preserve boolean values, validate dialog-specific answers, bind requests to their owning session, and reject stale replies |
| Pi extension cancellation | Queued tool hooks and a late confirmation were not bound to the cancelled turn                                                                  | Capture the turn signal, pass it to confirmation, and recheck before allowing execution                                    |

The runtime contract is that approval gates execution, cancellation invalidates
pending grants, and persisted events preserve the order in which operations
were introduced. It is not sufficient for a permission overlay to be visible
or for a tool to appear in a capability list.

A real PTY run used the installed Pi runtime and the existing
`commandcode/z-ai/glm-5.3-flash` configuration with global extensions. It ran in
a disposable workspace and separate Cognia home, with `default` permission
mode. A bash command wrote `approval-probe-complete.txt`: the file remained
absent for five seconds while approval was pending, appeared with the expected
contents only after Enter, and the model returned `VERIFIED` with recorded
usage. The prompt did not contain that uppercase response marker. This proves
the tested native bash approval path blocks side effects; it does not establish
that every global extension or external backend has the same guarantees.

The saved normal configuration had `permissionMode: "plan"` and
`pluginTools: false`. These settings intentionally restrict capabilities; the
audit did not overwrite them. The live screen also showed a tool spinner before
approval despite no filesystem effect, distinguishing misleading presentation
from actual premature execution.

Full repository coverage was attempted in an isolated output directory and
stopped after unrelated connector and UI failures. Full TypeScript checking
failed across the shared working tree; errors found in this audit's test
fixtures were addressed separately. Neither run establishes a clean
repository-wide baseline. Focused test totals and coverage must be interpreted
per group, because several groups exercise overlapping modules.

Behavioral references checked for this follow-up:

- [Pi 0.84.3 RPC](https://github.com/badlogic/pi-mono/blob/v0.84.3/packages/coding-agent/docs/rpc.md)
- [Pi extensions](https://github.com/badlogic/pi-mono/blob/v0.84.3/packages/coding-agent/docs/extensions.md)
- [ACP tool calls and cancellation](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Claude Code permission precedence and scope](https://code.claude.com/docs/en/permissions)

Final scoped checks for this follow-up:

- External session/parity/restart: 98 tests; session coverage 95.05% lines,
  90.42% branches, 90.24% functions, with the explicit 90% gate passing.
- Pi RPC and event mapping: 445 tests across eight suites; the client reached
  97.96% lines, 92.16% branches, and 98.71% functions, and the event translator
  reached 100% lines/functions and 97.63% branches.
- Ordered reducer: 97.08% lines, 90.76% branches, 100% functions.
- Approval presentation: 403 tests in the UI verification group; `Inflight` and
  `BottomRegion` reached 100% on all measures, and `TranscriptRegion` reached
  96% branches and 100% on the other measures. These totals overlap other runs.
- A second real PTY scenario, after staging the updated pinned Pi extension,
  waited five seconds on the approval screen, pressed Esc, observed
  `Turn stopped by user`, and verified no file existed after another five
  seconds. The screen explicitly displayed `Waiting for approval`.

The JavaScript-only build deliberately skips extension asset staging. The final
cancellation test therefore used `stagePiExtension` to copy and verify the
updated extension and manifest into `cli/dist/sidecar/pi-extension` before
launch. Rebuilding JavaScript alone would have tested the old staged extension.

The fully bundled layout check exposed an additional packaging failure that the
source-sidecar acceptance run could not detect. `build-cli-binary.mjs
--layout-only` succeeded, but executing its sidecar failed with
`Cannot find module '@babel/traverse'` from webclone's JavaScript analyzer.
All six coding-loop acceptance cases then failed before sidecar readiness.
The Node bootstrap also piped stderr without consuming it, replacing this
useful error with `sidecar exited before ready` and risking backpressure.
These findings require packaging and startup-diagnostic regression checks;
a successful JavaScript bundle alone is not a usable packaged coding agent.

The packaging failure was traced to drift between builders: Bun had a webclone
rewrite that pkg/esbuild did not share. The repair extracts that existing
compatibility into one bundle plugin, turns the hidden Babel require into a
static import, and resolves Babel/CSS dependencies from webclone's package.
It also corrects the previous Bun rewrite's extra `.default` under Babel 8.
Both bundlers now execute the actual AST and CSS transformations without nearby
`node_modules`; the corrected packaged sidecar emits `{"type":"ready"}` and
exits successfully on stdin EOF.

A post-readiness IPC check caught a second bundled failure: the OAuth helper's
`import.meta.url === argv[1]` entry guard became true inside the sidecar bundle.
Its command-line reader consumed the first host message and exited with code
zero. This produced `sendPrompt failed: sidecar not running` without stderr.
The packaging regression must therefore send an IPC request and observe a reply;
checking only `ready` or successful EOF is insufficient.

The helper now requires both its own filename and matching entry URL. It still
works as a standalone helper when inheriting a sidecar role. The packaging and
helper regression group passed 25 tests, including a real bundled import that
must not consume host IPC. The rebuilt sidecar answered two consecutive status
requests before a normal EOF shutdown.

The startup diagnostic repair passed 48 tests across bootstrap and transport;
bootstrap coverage is 98.84% lines/statements, 94.73% branches, and 100%
functions. Capture is bounded and redacted before presentation, handles split
UTF-8 and credential fragments, and continues draining after readiness without
retaining runtime stderr.

The complete packaged loop then exposed an LSP path defect: the bundled loader
resolved the extension host relative to its old `lsp/` source directory. The
loader now handles both source and staged layouts for the service and installer.
Its 26-test group includes a bundled hover regression; loader coverage reached
93.33% lines, 91.42% branches, and 100% functions using the instrumented fixtures.

The Anthropic packaged path also required the SDK's platform-specific native
runtime. pnpm installs that optional package beside the SDK, so copying only
the SDK directory omitted the executable. Packaging now resolves and stages
the SDK-declared runtime version for the target, and fails early when it is
missing or mismatched. Five regression tests passed, including executing the
staged native runtime outside the repository. A rebuilt full-layout CLI also
completed a local Anthropic protocol request without source fallback.

Final packaged acceptance passed all six cases in 60.935 seconds against the
rebuilt sidecar: OpenAI and Anthropic each completed the coding/process/search
chain, recovered provider history after restart, and executed scoped persistent
terminal input/output. This run used the local debug sandbox helper through
`COGNIA_SANDBOX_EXEC`; it does not validate a signed release installer or every
cross-platform binary. The generated sidecar contained no debug instrumentation.

## Plan review and rendering follow-up

The screenshots exposed two distinct plan issues. A plain analysis report was
treated as a proposed implementation plan because the fallback accepted any
heading, two bullets, or long text. The fallback now requires a plan heading or
multiple proposed actions and ignores fenced examples. Explicit exit-plan tool
signals remain authoritative.

The plan overlay also occupied a small dock below the transcript. Its fixed
menu/header budget could leave only one document row; real PTY testing found
that the last row could be clipped even while the footer reported 100%.
Plan review now owns the full document region, wraps content into physical
terminal rows, and anchors the viewport across revisions and resizing.
Arrow keys, wheel, and page keys scroll the document; Enter opens actions,
arrow keys choose an action, and a second Enter selects it. Tab returns to
review, Ctrl+G edits, and Esc keeps planning.

Editing previously returned on process spawn with terminal input discarded.
It now suspends Ink, inherits terminal input/output, and waits for the editor
to close. The saved revision is shown before execution. Both execution choices
carry the reviewed Markdown explicitly, fixing current-session approval's use
of stale model history. A file changed after display is returned for review;
empty edits cannot authorize execution. `/plan refine <instructions>` includes
the reviewed plan and the requested revisions after entering plan mode.

The editor wait flags were checked against the official
[VS Code CLI](https://code.visualstudio.com/docs/configure/command-line),
[Sublime CLI](https://www.sublimetext.com/docs/command_line.html), and
[JetBrains CLI](https://www.jetbrains.com/help/idea/opening-files-from-command-line.html)
documentation.

Three real PTY regression cases pass: a Chinese project analysis stays an
ordinary answer; a 60×18 terminal can scroll to the last of 20 plan steps without
approving; and an external editor process updates the plan, returns to review,
and the next agent prompt contains exactly that revision. The App/overlay/effect
integration group passes 181 tests. The pure plan/editor group passes 78 tests
with a 90% coverage gate (at least 92.3% functions and 92.39% branches).

Markdown now retains list continuation paragraphs and nested quote/code/table
content, avoids duplicate task checkboxes, supports hard breaks and image
descriptions with targets, and preserves inline emphasis in links. Very narrow
tables become stacked header/value pairs; fenced code and nested prefixes respect
terminal width. Malformed streaming syntax and invalid entities are covered by
regressions, with terminal-control sanitization retained. The Markdown group
passed 208 tests, plus 42 plan-consumer tests, and real Ink/fullscreen rendering
at 10/20/40/80 columns. These checks do not imply native raster image support.

Tool groups now include bounded path/operation previews and explicit completion
state instead of only dim counts. Fullscreen virtualized blocks account for
their actual multi-row height, and expanded results use the same structured
previews as scrollback. The final tool-display group passed 198 unit tests and
12 real PTY cases, including grouped targets, expansion, and scrolling at 60
columns. VirtualizedTranscript reached 98.91% lines and 97.61% branches; changed
tool-rendering functions reached 99.28% statements and 94.67% branches. The
shared renderer's whole-file coverage remains below 90% due to other branches.

Full typechecking was rerun and still fails on the shared repository baseline.
Concurrent import/fixture issues in this change were corrected separately;
repository-wide coverage or typecheck success is not claimed.

## Codex engine and document-panel audit

The native CLI inspected on 2026-09-05 is `codex-cli 0.150.1`. Its locally
generated TypeScript bindings were used to check the initialize, thread-start,
resume, and config-requirements wire shapes against the adapter. The official
[app-server protocol documentation](https://learn.chatgpt.com/docs/app-server)
also describes server-initiated approval requests and their resolution lifecycle.
Schema generation and scripted transport tests do not spend model tokens.

The CLI session factory dropped two kinds of user settings: preset creation
discarded `codexOptions`, and lazy `codex` selection resolved the remembered
model before discovering the actual native preset. Both paths now forward the
selected engine's settings. A successful live model switch also updates the
next-turn model, rather than being overwritten by the original selection.
Rejected model switches leave the previous selection intact.

Document panels used both their own title and the body's identical opening
Markdown heading. The shared preparation helper now suppresses only that
matching opening heading, including formatted and Setext headings. Different
headings, later sections, and linked headings are preserved. Copy/export retains
the unmodified source. DocumentViewer, ConfirmOverlay, and the shared helper
passed 47 offline tests and actual Ink rendering at 40 and 80 columns.

Plan review now separates the title, compact statistics, progress, and active
controls more clearly. The visual pass retained physical-row scrolling, terminal
height budgets, and the two-input execution guard. Its 33 tests passed, and the
three real PTY plan cases passed again after polishing: analysis remains an
ordinary answer, short terminals reach the plan's final step, and execution
receives exactly the revision saved by the external editor.

`codex-acp` now explicitly selects ACP while the existing `codex` shortcut
retains native-first selection. Both ACP names resolve to the same ecosystem
surface, avoiding duplicate capability entries. The native options channel is
not advertised for ACP. ACP controls prefer declared configuration options,
validate approval ownership and option choices, and retain multi-part and rich
tool results instead of discarding everything after the first text block.

The native adapter previously inherited the local Codex sandbox when Cognia
sent no explicit sandbox. Client-side rejection of approval requests could not
protect plan mode when that inherited policy never produced a request. Start,
resume, and turns now send explicit permission policies: default is read-only
with untrusted-operation approval, plan/dontAsk are read-only without escalation,
acceptEdits permits workspace writes with untrusted-operation approval, and only
bypassPermissions selects full access without approval. Native trusted read-only
commands may still run without a prompt; this is not a promise to confirm every
command. The synthesized sandbox picker reflects the effective permission ceiling.

One live native test was run after rebuilding the CLI: `codex-app-server` with
the locally cached `gpt-5.4-mini`, low reasoning, a disposable workspace and
Cognia configuration, and the existing native Codex login. The real PTY rendered
the derived arithmetic answer `4786`, returned to its idle composer, and restored
terminal modes on exit. There were no test retries. This verifies a real text
turn, not every tool, approval, or resume path. The local ACP adapter package
was absent; no download, ACP live request, or account configuration change was
performed. ACP and concurrency acceptance remains scripted-transport evidence.

The native lifecycle regressions cover cancellation before admission, immediate
interruption when admission arrives, overlapping approval callbacks, approval
session ownership, stale completion, and late notifications after close/delete
and resume. Unresolved revoked admissions remain fenced rather than being
assigned to a newly resumed turn. Review was performed separately from the
implementation; these timing cases were tested without live model traffic.

## Session-statistics memory follow-up

The crash screenshot shows V8 heap exhaustion while parsing JSON after an
asynchronous file operation. The `/agent-stats` vendor-history path had unbounded
whole-file reads and retained parsed conversations during listing and analysis.
A synthetic 21 MiB JSONL input reproduced SIGABRT with the same unsigned-short
JSON-parser stack pattern under a 96 MiB heap. This establishes a reproducible
failure path, not the provenance of the user's original crash.

The reader now checks file size before decoding, caps each file at 16 MiB,
handles growth after stat, closes descriptors on every outcome, and shares byte
reservations correctly between concurrent readers. Discovery and analysis each
have a separate 64 MiB input budget. Skipped files and exhausted budgets are
reported as incomplete statistics, including when no summaries remain. Original
history files are not changed. Input-byte limits are not equivalent to a heap
size guarantee for arbitrary JSON expansion.

The 29-test memory group passed, including concurrent tiny files, UTF-8 chunk
boundaries, growing/shrinking files, independent phase budgets, and the small-heap
child-process regression. Both source files reached 100% lines/functions and
over 93% branches. A read-only run against the actual local vendor histories
also completed in a separate Node process with `--max-old-space-size=512`, emitted
the statistics overlay data for 25 conversations, and used approximately 48 MiB
heap at completion. That measurement is not a peak-memory figure. The last
operation before the original screenshot remains unknown, so its exact cause
is not claimed resolved.

Final combined acceptance for this follow-up passed 14 Jest suites / 628 tests.
The JavaScript CLI bundle rebuilt successfully and the scoped ESLint check
passed. The live smoke preceded the final additional late-admission cleanup;
those final changes received offline regressions rather than another model call.
Coverage is not uniformly above 90%: the native client and ACP client's existing
whole-file branch coverage remain below that gate, as does the CLI session
factory's branch coverage. The repository-wide TypeScript check also exhausted
its configured heap during this pass; it was not retried. No repository-wide
typecheck or coverage success is claimed.
