# Built-in Agent tool gap analysis (2026-07-18)

> **REVISED 2026-08-14 — parts of this note are superseded.**
> Every conclusion below was re-verified against code by
> [`agent-builtin-tool-completeness-audit-2026-08-14.md`](./agent-builtin-tool-completeness-audit-2026-08-14.md)
> ([中文](./agent-builtin-tool-completeness-audit-2026-08-14.zh.md)). Four corrections:
>
> 1. **"Remaining opportunity #2 — push-driven monitoring" is CLOSED.** `Monitor`,
>    `monitor_cancel` and `monitor_list` ship today in the `coreFiles` category, backed by
>    Rust `crates/cognia-jobs`. Read §86–94 below with that in mind.
> 2. **"Remaining opportunity #3 — checkpoint/rewind and worktree lifecycle" is PARTLY MOOT.**
>    `EnterWorktree`/`ExitWorktree` ship natively in the vendored Agent SDK
>    (`sdk-tools.d.ts:2922,2932`), and SDK-owned checkpoint control already exists behind the
>    `checkpoint` capability (`sidecar/dispatch/control.mjs:15-39`). What is missing is
>    agent-facing access, not the mechanism.
> 3. **"Waitable background commands" is CLOSED ONLY ON THE DESKTOP.** On the external-agent
>    bridge the Monitor family is advertised but always errors (no `hostRpc` is passed,
>    `sidecar/cognia-tool-bridge.mjs:199-212`), and under the headless CLI every background-shell
>    call stalls 30 s and fails because nothing answers `host_rpc`.
> 4. **This note's own verification contract is UNMET.** It requires that "English and Chinese
>    tool catalog messages remain in parity"; 9 `codegraph_*` `descriptionKey`s are missing from
>    both locales.
>
> The "Existing Cognia coverage" table below remains accurate. Its claim that adding duplicate
> tools "would increase prompt cost without adding capability" also still holds.

## Scope

This note records the cross-vendor research behind the built-in tool changes. It is intentionally a research artifact rather than an ADR: the existing Agent dispatch, permission, confinement, and tool-registry decisions remain unchanged.

Compared surfaces:

- Cognia's Anthropic Agent SDK path and cross-provider AI SDK path
- Claude Code's current built-in tool catalog and task/background execution behavior
- Codex's current shell, patch, web search, MCP, subagent, approval, and long-running-work patterns

Primary sources:

- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- [Claude Agent SDK task migration](https://code.claude.com/docs/en/agent-sdk/todo-tracking)
- [Claude Code scheduled tasks and Monitor behavior](https://code.claude.com/docs/en/scheduled-tasks)
- [Codex CLI capabilities](https://learn.chatgpt.com/docs/codex/cli)
- [Codex sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security)

## Existing Cognia coverage

The repository already covers most of the high-value coding-agent surface:

| Capability                   | Existing Cognia implementation                                 |
| ---------------------------- | -------------------------------------------------------------- |
| Search/read/edit/write/patch | `sidecar/builtin-tools/core/`                                  |
| Background shell execution   | `bash`, `bash_output`, `kill_shell`                            |
| Web search/fetch             | promoted host-routed `web_search` / `web_fetch`                |
| User elicitation             | host-routed `ask_user`                                         |
| Subagents                    | `dispatch_agent` plus controlled nesting                       |
| Skills and commands          | `Skill`, `SlashCommand`, and host routing                      |
| External tools               | MCP plus plugin tool bridge                                    |
| Code intelligence            | LSP, code graph, and ast-grep categories                       |
| Permissions and sandboxing   | shared rules, approvals, workspace confinement, and OS sandbox |
| Interactive programs         | node-pty-backed terminal REPL tools                            |

Adding duplicate web, patch, user-question, or subagent tools would increase prompt cost and naming ambiguity without adding capability.

## Closed gaps

### Structured session tasks

Claude Code now defaults to `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`; `TodoWrite` is a legacy compatibility path. Cognia's cross-provider path previously exposed only a stateless `TodoWrite` acknowledgement.

The new session task graph adds:

- stable task IDs across turns in one sidecar session;
- incremental create/get/list/update operations;
- `pending` / `in_progress` / `completed` lifecycle plus deletion;
- owner, active-form label, description, and structured metadata;
- reciprocal `blocks` / `blockedBy` edges;
- missing-task, self-dependency, and cycle validation;
- prevention of completion while prerequisites remain incomplete;
- atomic multi-edge validation and dependency cleanup on deletion.

`TodoWrite` remains available so existing renderers and older prompts continue to work.

### Waitable background commands

The previous `bash_output` required tight polling and offered no way to rediscover a shell ID. The enhanced surface adds:

- `wait_ms` long-polling (bounded to 30 seconds) for output or process exit;
- `max_chars` paging that preserves unread output for later calls;
- `list_shells` inventory with command, cwd, status, exit code, timestamps, and duration;
- race-safe waiter notification on output, error, and close;
- unchanged session teardown, ring-buffer, permission, and confinement behavior.

This follows the useful part of Claude Code's event-driven Monitor pattern and Codex's waitable process-handle model without introducing a second process runtime.

### Cross-provider deferred tool search

The Anthropic Agent SDK already honors `alwaysLoad` and defers the rest of the MCP surface behind its native tool search. AI SDK providers previously ignored the resolved runtime policy and serialized every permitted built-in, plugin, and MCP schema into every step.

The AI SDK path now uses the installed AI SDK 6 `prepareStep` / `activeTools` contract to add:

- a resident `ToolSearch` tool with ranked free-text discovery and exact `select:` activation;
- session-scoped activation that survives manual-loop legs and later user turns;
- metadata-derived always-load built-ins plus configured always-load tools and servers;
- stable active-tool order for prompt-cache compatibility;
- discovery over the already allow/deny-filtered map, so deferred loading cannot restore a denied tool;
- bounded discovery results and explicit reporting for unavailable exact names.

The full tool map remains registered with AI SDK so tool-call replay stays valid; only the schemas exposed to each provider step are narrowed.

## Remaining opportunities

These are real gaps, but they need separate designs rather than being folded into this change:

1. **Restart-persistent task state.** Structured tasks persist across turns in a live session, but are not yet checkpointed into resumable conversation storage.
2. **Push-driven monitoring.** Long-polling removes busy loops, but a full Monitor tool would need safe mid-turn event injection, backpressure, cancellation, and transcript persistence.
3. **Checkpoint/rewind and worktree lifecycle tools.** Cognia has git and task-workspace subsystems, but no unified built-in Agent contract for reversible checkpoints or worktree enter/exit.
4. **Broader LSP actions.** Type definition, implementation lookup, workspace symbols, safe rename previews, and code actions require capability negotiation and edit-approval integration.

## Verification contract

The implementation is complete only when:

- focused Node tests cover the task graph and background-shell behavior;
- metadata parity proves every declared tool is implemented and permission-classified;
- both dispatch paths inject one session store;
- AI SDK tool-map rebuilds retain task state;
- English and Chinese tool catalog messages remain in parity;
- sidecar tests, typecheck, lint, i18n checks, and changed-file coverage pass.
