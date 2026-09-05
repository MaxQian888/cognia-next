# TUI feature audit — 2026-09-05

This checklist records the registered command surface and its local validation.
It does not claim that every provider, remote Host, MCP server, marketplace, or Git hosting integration was contacted.
This pass used offline fixtures and temporary workspaces; zero live model requests were made.

## Registered entry points

The registry contains 78 commands and 118 subcommands. Each root and subcommand was dispatched without executing its returned effect.
The table records that routing inventory; behavioral evidence is recorded separately below.

| Command       | Aliases                    | Root effect  | Subcommands                                                                                                                |
| ------------- | -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| /settings     | config                     | openOverlay  |                                                                                                                            |
| /provider     |                            | openOverlay  | usage, inspect, capabilities, probe                                                                                        |
| /model        |                            | modelPicker  |                                                                                                                            |
| /mode         |                            | openOverlay  |                                                                                                                            |
| /think        | thinking, effort           | openOverlay  |                                                                                                                            |
| /sessions     |                            | openSessions |                                                                                                                            |
| /usage        | cost                       | openOverlay  |                                                                                                                            |
| /statusbar    |                            | openOverlay  |                                                                                                                            |
| /mascot       |                            | openOverlay  |                                                                                                                            |
| /theme        |                            | openOverlay  |                                                                                                                            |
| /output-style | outputstyle                | openOverlay  |                                                                                                                            |
| /agent-mode   | agentmode                  | runtime      |                                                                                                                            |
| /backend      |                            | openOverlay  |                                                                                                                            |
| /layout       |                            | openOverlay  |                                                                                                                            |
| /mouse        |                            | openOverlay  |                                                                                                                            |
| /select       |                            | openOverlay  |                                                                                                                            |
| /open         |                            | notice       |                                                                                                                            |
| /editor       |                            | editorInfo   |                                                                                                                            |
| /retry        | resend                     | notice       |                                                                                                                            |
| /transcript   | history                    | openOverlay  |                                                                                                                            |
| /copy         |                            | notice       |                                                                                                                            |
| /tools        |                            | openOverlay  |                                                                                                                            |
| /cwd          | cd                         | notice       |                                                                                                                            |
| /about        | version                    | notice       |                                                                                                                            |
| /handoff      |                            | handoff      |                                                                                                                            |
| /attach       |                            | notice       |                                                                                                                            |
| /detach       |                            | detachHost   |                                                                                                                            |
| /sync         |                            | notice       | status                                                                                                                     |
| /clear        | new                        | openOverlay  |                                                                                                                            |
| /help         |                            | openOverlay  |                                                                                                                            |
| /exit         | quit                       | exit         |                                                                                                                            |
| /goal         |                            | goalRun      | status, pause, resume, stop, list                                                                                          |
| /workflow     | wf                         | runtime      | list, run, inspect, runs, replay, create, edit, apply, discard, save, exit                                                 |
| /agents       |                            | runtime      | panel, list, models, run                                                                                                   |
| /team         |                            | runtime      | list, show, auto, run                                                                                                      |
| /memory       | mem                        | runtime      | list, add, show, delete                                                                                                    |
| /remember     |                            | runtime      |                                                                                                                            |
| /plan         |                            | notice       | explore, list, show, diff, delete, refine                                                                                  |
| /loop         |                            | notice       | pause, resume, stop                                                                                                        |
| /tasks        |                            | runtime      | list, show, pause, resume                                                                                                  |
| /council      |                            | runtime      |                                                                                                                            |
| /orchestrate  |                            | runtime      |                                                                                                                            |
| /status       |                            | runtime      |                                                                                                                            |
| /models       |                            | runtime      |                                                                                                                            |
| /balance      |                            | runtime      |                                                                                                                            |
| /limits       | usage-limits, subscription | runtime      | presets                                                                                                                    |
| /agent-stats  | agent-insights, insights   | runtime      |                                                                                                                            |
| /bashes       | jobs                       | notice       | actions, view, kill, fg                                                                                                    |
| /review       |                            | send         |                                                                                                                            |
| /commit       |                            | runtime      | apply, stage-all, cancel                                                                                                   |
| /pr           |                            | runtime      | apply, cancel                                                                                                              |
| /stack        |                            | runtime      | on, off, check, restack, push                                                                                              |
| /fix          |                            | fixRun       |                                                                                                                            |
| /mcp          |                            | runtime      | panel, list, logs, reconnect, show, tools, resources, prompts, auth, logout, presets, add, remove, enable, disable, toggle |
| /logs         |                            | runtime      |                                                                                                                            |
| /skill        |                            | runtime      | panel, list, show, files, enable, disable, enable-all, disable-all, toggle, create, delete                                 |
| /plugin       | plugins                    | runtime      | list, show, tools, enable, disable, reload, install, preview, update, uninstall, marketplace, sources, trust               |
| /view         | cat                        | runtime      |                                                                                                                            |
| /context      | ctx                        | runtime      |                                                                                                                            |
| /compact      |                            | compact      |                                                                                                                            |
| /diff         | changes                    | gitDiff      |                                                                                                                            |
| /analyze      | debug                      | analyzeBash  |                                                                                                                            |
| /export       |                            | runtime      |                                                                                                                            |
| /resume       |                            | openSessions |                                                                                                                            |
| /continue     |                            | resumeLast   |                                                                                                                            |
| /doctor       |                            | runtime      |                                                                                                                            |
| /hooks        |                            | runtime      | list                                                                                                                       |
| /rewind       |                            | rewindList   | apply, files, conversation                                                                                                 |
| /add-dir      |                            | addDir       | list, remove                                                                                                               |
| /permissions  | allowed-tools              | runtime      | list, remove, clear                                                                                                        |
| /init         |                            | runtime      | create, regenerate, rewrite, optimize, preview, scaffold, apply                                                            |
| /search       | find                       | notice       |                                                                                                                            |
| /expand       |                            | notice       |                                                                                                                            |
| /inspect      | cells                      | notice       |                                                                                                                            |
| /keybind      | keybinding, keys           | openOverlay  |                                                                                                                            |
| /route        |                            | notice       | auto                                                                                                                       |
| /vim          |                            | flag         |                                                                                                                            |
| /menu         | actions, quick             | openOverlay  |                                                                                                                            |

## Behavioral checks

Command/runtime, UI/state, and real PTY fixture suites were checked separately.
A passing injected test validates local behavior, not an external service deployment.

- Integrated command/runtime/component/hook/state plus transcript/database sweep: 239 suites, 3,600 tests. Initial result was 235 suites / 3,596 tests passing; four stale fixture assumptions about the default permission mode or config home were corrected. The separate four-suite rerun passed all 126 tests.
- Real PTY fixtures: 11 suites / 68 tests passed, including plan review, tools, ordering, terminal interactions, persistence, errors, and cancellation.
- JavaScript CLI build: `node scripts/build/build-cli.mjs --js-only` passed.
- Scoped ESLint and whitespace diff checks passed for the edited audit code and fixtures.
- Full-repository coverage and type checking are not certified by this scoped pass. Targeted controller coverage still has branch gaps; no claim of 90% coverage across every file is made.

## Confirmed fixes

- Slash-command parsing preserves internal whitespace in paths, quoted arguments, and multiline text.
- Mixed-case contributed command names resolve through their aliases.
- `/about` reuses the active backend identity and no longer displays the built-in provider/model/auth for an external engine.
- `/models` uses the same external-model picker as `/model` instead of sending a built-in provider model to an external backend.
- Settings show the resolved backend model, scope provider settings explicitly, and distinguish requested from effective permission mode.
- Connection cleanup removes an agent when capability negotiation fails after transport connection.
- Goal resume restarts the streaming runner; loop pause/resume/stop control the foreground loop and preserve its continuation instead of becoming new prompts.
- Follow-up failure-state check: stopping an already-settled failed goal/loop now persists the stop instead of only clearing its UI owner. Two regressions failed before the fix; all 89 tests across the effect/goal/loop suites passed after it, without model calls.
- Team and workflow cancellation suppresses late events and releases timers/subscriptions; runtime controllers receive the caller's cancellation signal.
- Model pickers ignore obsolete asynchronous responses; external thinking controls use advertised engine capabilities.
- Session browsing skips unreadable entries, transcript parsing rejects malformed records, and resume/export errors reach the UI.
- Document copy respects configured clipboard handling, and skill enablement awaits completion.
- MCP preserves SSE transport, validates transport selection, invalidates authenticated tool caches, and suppresses canceled results.
- Plugin update/toggle failures and memory initialization/recall failures are reported instead of showing false success.

## Feature groups and verification boundaries

| Group                                                | Checked behavior                                                                                           | Evidence / boundary                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Command palette, help, aliases, forms                | Registration, dispatch, argument preservation, unknown/missing input                                       | 44 command suites / 352 tests passed before later loop-control additions                                  |
| Model/provider/mode/thinking/backend/settings        | Active-engine identity, persisted vs effective settings, connection cleanup                                | 9 isolated/injected controller suites / 184 tests passed; App integration checked separately              |
| Sessions/resume/retry/clear/transcript/copy/export   | Corrupt-record filtering, per-file read failures, exact export, reset without deleting history, retry once | 23 core tests and two added real PTY fixture cases passed; combined DB/session validation 51 tests passed |
| MCP                                                  | Transport persistence, invalid transports, auth cache invalidation, empty caches, canceled probes/results  | Injected transport tests; no remote MCP server contacted                                                  |
| Skills                                               | ID validation, enable/disable persistence, removed-skill cleanup, cancellation                             | Local fixtures and injected storage                                                                       |
| Plugins                                              | Live toggle vs persistence failures, update-query failure reporting, canceled install/update flow          | Injected runtime/marketplace; no package installed or remote marketplace queried                          |
| Memory/context                                       | Initialization failures, recall status, cancellation before writes or late reports                         | Injected local stores; no embedding/model call                                                            |
| Goal/loop/team/agents/tasks/workflows                | Start/pause/resume/stop, timer/subscription cleanup, late events                                           | Scripted runners; no autonomous live task launched                                                        |
| Terminal/layout/theme/editor/search/view/diagnostics | Existing unit and PTY fixtures                                                                             | No claim of every terminal emulator or platform                                                           |
| Git review/commit/PR/stack, Host attach/sync/handoff | Existing injected routing/controller checks                                                                | No real commit, PR publication, or remote Host mutation                                                   |

## Subagent and background-agent follow-up

- Child setup checks cancellation before option resolution and again before execution; an approval arriving after cancellation is not forwarded to the executor.
- Nested context registration is inside the cleanup boundary, so a partial registration failure retires the context and child session.
- Child execution uses its assigned working directory without mutating the parent configuration.
- The agents panel's `s` action supports owner-scoped CLI background runs as well as native SDK tasks. Native stop failures and unavailable handles produce notices.
- Each background run has its own cancellation controller linked to its parent. Canceling one sibling does not cancel the others; late output and late success from the canceled run are suppressed.
- Background failures retain `error` status rather than becoming successful string results. Interruptions retain their outcome across live collection and journal collection.
- Duplicate live run identifiers are refused before launching execution. Discovery and panel/model loading honor cancellation, and discovery failures reach the UI.
- Runner/live-output/panel checks: 5 suites / 134 tests passed. Controller/routing checks: 2 suites / 126 tests passed. Persistent background journal checks: 14 tests passed; database setup/cleanup made this suite take 103 seconds.
- Final dispatch integration: 43 tests passed. Across these nine targeted suites, 317 tests passed; the JavaScript CLI rebuild, scoped ESLint, and diff whitespace checks also passed. Full-repository coverage is not certified by this pass.
- Validation uses injected executors and isolated configuration homes; no live model request is required for these lifecycle checks.

## MCP discovery and Pi session recovery follow-up

- MCP tool discovery forwards stored OAuth credentials and caller cancellation. Canceled list/tool requests suppress late overlays and errors.
- Rich probes bound discovery as well as connection, cancel retries, close late connections, and classify authorization errors instead of reporting an empty connected server. Shared transport refuses connections canceled during setup.
- OAuth requires an exact callback state, uses cryptographic state generation, and cancels callback/connection/token-exchange progression with resource cleanup.
- Pi's next prompt now recovers a known exited process by reopening the same persisted session ID. Recovery is deduplicated, retires old listeners, and keeps the affected session's creation options rather than another session's last-used settings. Prompts already sent are not automatically replayed.
- Local installed Pi source (`dist/main.js`) confirms that `--session-id` opens the existing project session when present. The reported exit's underlying cause was not established from available logs; this fix addresses the stale process handle and recovery path.
- Pi adapter/peer/CLI integration: 243 tests passed. These tests use fake process hosts; no live model requests were made.
- MCP follow-up: 13 suites / 242 tests passed. JavaScript CLI rebuild and scoped lint/diff checks passed. No whole-repository coverage claim is made.

## Test interruption and isolation incident

The initial UI sweep hit ENOSPC while creating test caches and temporary files.
A disposable binary-staging copy generated by this work was removed; source,
user histories, the current JavaScript CLI, and native helpers were preserved.
Disk-full fixtures also exposed a production database bug: a scheduled flush
rejection was unhandled, and a failed disposal prematurely marked the handle
closed. Background errors are now logged while explicit flush/dispose callers
still receive failures, preserving retryable dirty state.

An added App regression accidentally entered credential management and reached
the default writer, modifying the local OpenAI API-key field. Tests were paused.
Only the confirmed test value was removed, with other credential fields and file
permissions verified unchanged. No verified original value was found; an existing
OpenAI key, if previously configured there, must be re-entered locally. No key or
credential content is included in this report. The App test file now uses its own
temporary COGNIA_HOME and explicit credential writer injection; subsequent task
verification uses a temporary COGNIA_HOME at the process boundary as well.

Follow-up: the first cleanup left an empty `providers.openai` object, which failed
startup credential validation. That exact empty entry was subsequently removed;
other credential fields and file permissions were verified unchanged. The repaired
file passed the production credential schema. This repair does not restore the
unavailable original key.
