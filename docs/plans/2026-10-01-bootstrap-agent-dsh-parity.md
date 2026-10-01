# Bootstrap Agent customization and d.sh capability parity

Date: 2026-10-01 (Asia/Shanghai).

The expansion is authorized by the request to cover every capability of d.sh and
make the model and other settings customizable. The reference remains
[`f8b8ff864694624fe86157004e484f25e0397a3a`](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh),
verified against GitHub `main` on this date. Its entire configuration block,
tool implementation, history/compaction logic, API transport and CLI were read.
This is an independent implementation; upstream script source is not copied.

## Scope and acceptance

| Reference capability                                  | Cognia implementation / acceptance                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arbitrary connection and model, environment overrides | Validated JSON, CLI overrides and environment compatibility; mock request verifies selected model and endpoint                                              |
| Interactive connection setup and hidden key entry     | `configure` writes a secure configuration containing environment references; chat credentials remain invocation-scoped                                      |
| One-shot task and stdin task                          | `run`, task override and bounded stdin input; existing `init` readiness and exact argv handoff retained                                                     |
| Interactive prompt and exit/EOF                       | `chat`, `/exit`, `/quit`, `/help`, Ctrl+D                                                                                                                   |
| `/clear`                                              | Clear conversation and saved session; close/reset persistent shell                                                                                          |
| Ctrl+C during model or tool execution                 | Cancel current turn and return to prompt; terminate affected process group and reset shell state                                                            |
| Persistent Bash state across calls and turns          | One owned shell per chat; cwd, exports, functions and sourced environments survive ordinary turns                                                           |
| `bash` tool                                           | DSH profile tool schema plus compatible dispatch; configured command deadline                                                                               |
| `str_replace_editor` view/create/str_replace/insert   | Absolute workspace paths, numbered lines, inclusive range with EOF=-1, unique replacement and omission-to-delete, insertion after line including boundary 0 |
| Directory view                                        | Two-level bounded enumeration, excluding hidden entries, `node_modules` and `__pycache__`; never follow directory symlinks                                  |
| Output clipping and binary rejection                  | Bounded stdout/stderr drainage and UTF-8 text editor with configurable file/output limits                                                                   |
| Session resume/save/disable/custom path               | DSH-compatible role-TAB-JSON transcript, complete-turn commits, secure atomic persistence and lock; optional for one-shot run, default for chat             |
| Streaming and nonstreaming                            | Bounded SSE decoder handles fragmented content/reasoning/tool arguments and validates whole response before mutation                                        |
| Reasoning display/replay/control                      | Optional display; reasoning_content retained for tool-call continuation; explicit generic provider parameters and DSH environment compatibility             |
| Maximum tokens, steps and API/command deadlines       | Configurable output tokens and bounded step/time/output/response/context budgets                                                                            |
| System prompt                                         | User-defined persona with host tool/readiness instructions retained                                                                                         |
| Manual `/compact`                                     | Guarded model summary retains complete recent exchanges and applies only a smaller usable checkpoint                                                        |
| Automatic compaction                                  | Configurable estimated context window, threshold, retained history, summary output and retry budget                                                         |
| Tool-result pruning                                   | Configurable head/tail pruning before summary without removing tool identities or breaking call/result ordering                                             |
| Context-overflow recovery                             | Bounded detection and compaction/retry, unchanged history when no safe reduction is available                                                               |
| Running/compacting status                             | CLI diagnostics on stderr, task/chat output on stdout                                                                                                       |
| Minimal runtime                                       | One native executable, no Node, Tauri or application runtime required                                                                                       |

## Added customization

`model` supports endpoint suffix, request timeout, stream/showThinking,
maxTokens, temperature, topP, seed, reasoningEffort, explicit provider `thinking`,
validated `extraBody`, ordinary headers and headers whose values are read from
environment references. Authentication can use Bearer, a custom header or no
authentication for an explicitly selected compatible endpoint. Sensitive header
values stay in environment/keyring references. The wire protocol is OpenAI Chat
Completions; changing a model name does not convert incompatible provider APIs.

`tools` controls shell/editor grants, native or DSH argument profile, shell
executable/arguments, ordinary shell environment and maximum text-file size.
`context` exposes every reference compaction knob plus configurable pruning.
The existing initialization reuse input/output declarations remain available.
The Cognia form exposes frequent controls and validates complete advanced JSON
sections at save and execution boundaries. All options participate in immutable
environment versions and setup fingerprints through the existing persistence.

## Deliberate safety and product differences

The upstream self-modifying script embeds keys; Cognia persists credential
**references** instead. The text editor stays confined to the selected workspace
and rejects symlinks. This is not an OS sandbox: shell commands use the selected
host or environment's existing permissions. Bash is the default shell; an
alternative POSIX-compatible shell and its arguments can be selected explicitly.

SSE transport fragments are buffered and decoded after the response completes.
Terminal text and optional thinking are emitted only after the complete reply
passes the credential/PII gate. This prevents a
credential split over SSE fragments from appearing on screen. Model tool calls
execute only after every call in the response is validated. Incomplete turns are
not saved, while completed filesystem mutations are not rolled back on cancel.

The implementation preserves existing initialization defaults instead of
silently adopting upstream's larger time budgets. Context token counts are
estimates; serialized byte limits independently bound memory and request size.
Session files restore conversation, not a shell process after program restart.

## Verification

Verified on macOS Apple Silicon on 2026-10-01:

- `cargo test -p cognia-bootstrap-agent -- --test-threads=4`: **76 passed**.
- Eight focused Jest suites: **201 passed**, covering configuration round trips,
  the settings form/manager, immutable versions, setup reuse, executor and native
  transport integration. The final authless credential-environment validation
  assertion was rerun in the 72-case configuration suite and passed.
- Launcher packaging tests: **6 passed**. Release build and desktop binary staging
  succeeded. Release and staged binary SHA256 both equal
  `681c75f578e248198e9a8fdb1994c0d0954263a4adfb56580807570d13647d24`.
- Actual release executable with a synthetic local OpenAI-compatible HTTP
  provider and real PTY signals: **61/61 passed**. This exercises request options,
  stdin, persistent Bash/functions/virtualenv, all editor commands, sessions,
  manual/automatic compaction, pruning, overflow recovery, fragmented SSE,
  Ctrl+C recovery/descendant cleanup, SIGTERM/terminal echo restoration,
  readiness, changed-input/missing-output invalidation and exact handoff.
  Temporary evidence is in
  `/private/tmp/cognia-bootstrap-acceptance-20261001/run-bhjahjejje/report.json`.
- Package Clippy (`--all-targets --all-features -- -D warnings`), Rust format,
  scoped ESLint/Prettier, diff whitespace, i18n build/check, i18n sort and
  `lint:i18n` pass. Test-gap and dual-locale audits report no blockers.

Full repository typecheck remains blocked by unrelated diagnostics in the Lark
workbench test, external Node-backend tests, workflow publication lifecycle and
the wallpaper E2E test's missing `sharp` dependency. No Bootstrap Agent file
appears in the final diagnostic output. Full repository lint exits 134 because
ESLint exhausts its 4 GiB heap while scanning existing cached headless capture
chunks; scoped lint passes.

The browser loaded `/workspace?tab=environments` in an isolated test profile,
but the existing workspace-management request did not open its dialog. The
Bootstrap Agent form is therefore covered by component/integration tests, not
claimed as browser or real desktop acceptance. No live paid provider, Linux
container build or Windows native runtime was validated. Native Windows is
unsupported; use a Unix host/WSL. Mock providers, source/unit checks, executable
flows, desktop UI and live provider acceptance remain distinct evidence.

Sources: [pinned d.sh source](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh),
[DeepSeek thinking/tool-call protocol](https://api-docs.deepseek.com/guides/thinking_mode/).
