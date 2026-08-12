# Codex App single-runtime relay options

Date: 2026-08-11  
Status: Architecture exploration; desktop relaunch PoC not yet executed  
Goal: Let Cognia Web display and control the same tasks and runtime used by the local Codex desktop App, while retaining App-owned Browser, Computer Use, plugins, MCP servers, and skills.

## Verdict

There are two technically viable relay shapes, but they are not equally safe:

1. **A second client on the App Server Unix socket** is supported by the App Server's multi-client implementation. It is useful for inspection and controlled handoff, but it introduces multi-subscriber request races and one known incompatibility with the external-clock request path.
2. **A single-connection inline multiplexer** is the best Cognia PoC. It sits between the desktop App and the App-owned stdio App Server. App Server continues to see one initialized desktop connection; Cognia injects namespaced client requests into that connection and receives mirrored notifications. This avoids creating a second runtime and avoids most multi-client ownership ambiguity.

The installed desktop build contains two private integration seams that make both experiments possible after a controlled App relaunch:

- `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` makes the desktop App connect to `$CODEX_HOME/app-server-control/app-server-control.sock` over WebSocket-over-Unix when its daemon version check succeeds.
- `CODEX_CLI_PATH` overrides the executable the desktop App spawns. A relay shim can therefore be used as the CLI executable, forward non-App-Server invocations unchanged, and place itself transparently in the App's stdio App Server path.

Neither environment variable is a documented public desktop integration contract. They are appropriate for a version-pinned PoC, not a compatibility promise.

## Evidence from the installed App

The local build inspected was ChatGPT/Codex desktop `26.803.41515`, with bundled Codex CLI `0.147.0-alpha.6.5`.

The currently running desktop process owns this child:

```text
/Applications/ChatGPT.app/Contents/Resources/codex
  -c features.code_mode_host=true
  app-server
  --analytics-default-enabled
```

Its standard input, output, and error are socketpairs connected to the desktop parent. It has no active `app-server-control.sock` listener. Consequently, a separate Cognia client cannot attach to the current process as it is running today.

The same App-owned process tree includes:

- `codex-code-mode-host`;
- the bundled `cua_node/bin/node_repl` processes;
- Codex Computer Use MCP processes;
- configured third-party MCP servers and first-party plugin processes.

The desktop parent also owns per-task `/tmp/codex-browser-use/*.sock` endpoints. This matches the earlier live test: a task created inside the App could access the in-app Browser, while a second independently spawned App Server could see the skill but had no registered in-app browser session.

This is why sharing persisted task files or `CODEX_HOME` is insufficient. The relay must preserve the App-owned process, loaded `CodexThread`, connection capabilities, and native host registrations.

## What the App Server source guarantees

The official protocol supports stdio, WebSocket, Unix socket, and `off`. Unix transport is WebSocket-over-UDS. WebSocket is explicitly experimental and unsupported for production. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

For WebSocket, Unix, and official Remote Control transports, one App Server runtime accepts multiple connections. Each connection has its own `ConnectionId`; each loaded thread contains a set of subscribed connection IDs. `thread/resume` joins an already-loaded thread, returns the live snapshot, atomically subscribes the new connection, and replays pending server requests. Thread events are then sent to all subscribers. The detailed source evidence is recorded in [the companion primary-source note](./codex-app-owned-runtime-relay-source-notes-2026-08-11.md).

There is no exclusive connection-level writer inside one runtime. An initialized client that knows a loaded thread ID can submit input. The exclusive writer lock exists across App Server processes, which is why a second runtime cannot safely live-own the same task.

### Multi-client hazards

Directly attaching Cognia as a second client is mechanically possible, but not transparent:

- Approval, permission, MCP elicitation, and user-input requests are copied to all thread subscribers using the same server request ID. App Server stores one callback; the first valid response consumes it. The relay must nominate one approval authority. See [`outgoing_message.rs`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/outgoing_message.rs#L295-L403).
- A joining `thread/resume` connection receives pending requests again. A passive UI must not accidentally answer them.
- When the external clock source is enabled, `currentTime/read` requires exactly one subscribed client. Two subscribers produce `expected exactly one client subscribed to the thread, found 2` and stop that request path. See [`current_time.rs`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/current_time.rs#L85-L150).
- The downstream MCP extension profile is fixed when the loaded Codex session is created or resumed. A later connection cannot replace it. This is helpful when the App created the session, but it means a generic Web client cannot retrofit missing desktop capabilities.

These behaviors make a normal second client a poor default for simultaneous App + Cognia control.

## Recommended relay: one logical App Server connection

```text
Codex desktop App
       │ JSONL over stdio
       ▼
Cognia CLI shim / local broker
       │                         ┌─ authenticated loopback WS ─ Cognia Web
       ├─ mirrors notifications ─┤
       │                         └─ injects allowlisted client requests
       ▼
one App-owned App Server runtime
       ├─ one loaded task / writer
       ├─ code-mode host
       ├─ Browser / node_repl
       ├─ Computer Use
       └─ plugins, skills, and MCP servers
```

The desktop App still performs the only `initialize` handshake. The broker is not a second App Server client; Cognia Web speaks a smaller broker protocol.

### Message routing

App to server:

- Forward desktop requests, notifications, and responses byte-for-byte.
- Record task selection and lifecycle methods for the Web projection.

Server to App:

- Forward all notifications and server-initiated requests to the desktop App.
- Mirror notifications to authenticated Cognia Web viewers.
- Keep the desktop App authoritative for approvals, permission prompts, attestation, forms, and external-time requests.

Cognia to server:

- Inject only allowlisted client requests after the App's `initialized` notification.
- Use collision-resistant string IDs such as `cognia:<uuid>`.
- Route responses for those IDs to Cognia and do not deliver them to the desktop App.
- Let ordinary thread notifications continue to the App and the Web projection, so a Web-started turn appears in the desktop UI.

The first method allowlist should be narrow:

```text
thread/list
thread/read
thread/turns/list
thread/items/list
thread/resume
turn/start
turn/steer
turn/interrupt
thread/unsubscribe
```

Filesystem, process spawning, plugin installation, authentication mutation, settings mutation, deletion, archive, and raw remote-control methods should not be exposed in the first PoC.

### Why Browser Use should survive

This topology does not spawn a second App Server. A Web-started turn executes in the same App-owned process and loaded task that already owns the code-mode host, node REPL, Browser session registration, and plugin/MCP children. It also reuses the desktop connection's initialized capability profile instead of trying to reproduce it from Cognia.

This is the strongest architecture-level reason to expect Browser Use to work. It is not yet a completed end-to-end proof: the proof requires relaunching the desktop App through the shim and executing a Browser task initiated from Cognia Web.

## Alternative: App connected to a managed Unix daemon

The installed desktop code can choose this topology:

```text
Codex desktop App ─┐
                   ├─ WebSocket-over-UDS ─ one managed App Server
Cognia broker ─────┘
```

It is closer to the App Server's native multi-client architecture. It also enables the official Remote Control task in the same runtime when started with remote control enabled.

However, it has more operational and semantic risk for the first PoC:

- The desktop hook is private and requires a compatible managed daemon.
- The current machine has a stale/inactive control socket and no ready standalone managed install; daemon bootstrap would mutate local Codex installation state.
- Direct multi-client subscription retains the approval race and external-clock ambiguity described above.
- Managed daemon update/restart behavior can disconnect every attached client simultaneously.

This should be the second experiment, after the inline shim proves that a Web-initiated Browser turn can run in the App-owned runtime.

## Other relay choices

| Choice                                 | Same runtime      | Same live task         | Browser/Computer Use                       | Simultaneous App + Web  | Assessment                                                    |
| -------------------------------------- | ----------------- | ---------------------- | ------------------------------------------ | ----------------------- | ------------------------------------------------------------- |
| Inline stdio multiplexer               | Yes               | Yes                    | Preserved by construction                  | Yes, with broker policy | Recommended PoC                                               |
| Second client on App-owned Unix socket | Yes               | Yes                    | Expected                                   | Yes, but request races  | Useful diagnostic path                                        |
| Official Remote Control relay          | Yes               | Yes                    | Officially preserved                       | Yes                     | Best supported relay, but no public Cognia Web controller SDK |
| Separate App Server runtime            | No                | Persisted history only | Browser registration was absent in testing | No live shared writer   | Reject for target architecture                                |
| Desktop CDP/UI automation relay        | App remains owner | Indirectly             | Yes through the App UI                     | Brittle                 | Fallback only                                                 |

Official Remote is the only documented relay that explicitly preserves host plugins, MCP, skills, Browser, Computer Use, files, credentials, sandboxing, and approvals. Its documented controllers are mobile or another desktop App, not an arbitrary Web application. See [Remote connections](https://learn.chatgpt.com/docs/remote-connections).

## PoC gates

The PoC should be considered successful only if every gate passes:

1. The App launches through `CODEX_CLI_PATH=<relay-shim>` and still has exactly one App Server runtime.
2. Existing tasks load and render normally in the desktop App.
3. Cognia Web can list/read tasks and mirror live deltas without subscribing as a second App Server connection.
4. A turn started in Cognia Web immediately appears in the same desktop task.
5. That turn invokes `browser:control-in-app-browser`, lists the existing in-app browser, opens or navigates a page, and the desktop Browser pane visibly changes.
6. Computer Use and one ordinary MCP/plugin call also succeed.
7. An approval requested by a Web-started turn appears in the desktop App only; Cognia mirrors status but cannot race the response.
8. The App can send the next turn after a Web-started turn without a writer conflict or duplicated task.
9. Killing the Web connection leaves the App and App Server running; killing the shim fails closed and does not leave a publicly reachable listener.
10. Quitting and launching the App normally, without the environment override, fully rolls back the experiment.

The first controlled relaunch should be done only after saving current work and with explicit user approval. No desktop process was restarted and no daemon was bootstrapped during this research.

## Security boundary

The raw App Server must never be exposed to the cloud browser. The local broker should bind to loopback or an owner-only Unix socket and require a short-lived capability token. For a cloud Cognia page, use an outbound authenticated tunnel from the local broker; do not port-forward the App Server.

At minimum, enforce:

- exact Web origin allowlist and CSRF protection;
- device/user/task authorization before every injected request;
- one active input lease per task;
- desktop-only approval authority for the PoC;
- method and parameter validation;
- bounded queues and event replay cursors;
- redacted audit logs without prompts, tokens, or tool outputs by default;
- protocol-version pinning to the bundled CLI version;
- automatic disablement when the desktop/App Server version is unknown.

## Recommended next action

Build a disposable inline shim and a tiny loopback Web UI, then run one controlled desktop relaunch A/B test. Do not invest in the managed daemon or a cloud tunnel until the Browser gate succeeds. If the shim gate fails because the desktop rejects the substituted CLI or Browser peer authorization, the next experiment is the local-daemon hook; if both private hooks fail, the supported fallback is official Remote rather than a second runtime.

## Sources

- [OpenAI: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI: Developer commands](https://learn.chatgpt.com/docs/developer-commands)
- [OpenAI: Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [OpenAI Codex source at the inspected commit](https://github.com/openai/codex/tree/3d4d253f8f4a812c595cd59e2c114c2c3696c293)
- [Primary-source implementation notes](./codex-app-owned-runtime-relay-source-notes-2026-08-11.md)
