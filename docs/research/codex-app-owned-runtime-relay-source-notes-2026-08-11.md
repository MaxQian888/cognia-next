# Codex App-owned runtime relay: primary-source notes

Date: 2026-08-11  
Status: Source research  
Scope: Whether one Codex App Server runtime can serve desktop and relay clients at once, and whether an already-running ChatGPT/Codex desktop host can expose another listener.

## Source baseline

- Official documentation checked on 2026-08-11:
  - [Codex App Server](https://learn.chatgpt.com/docs/app-server)
  - [Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- Open-source implementation pinned to [`openai/codex@3d4d253f8f4a812c595cd59e2c114c2c3696c293`](https://github.com/openai/codex/tree/3d4d253f8f4a812c595cd59e2c114c2c3696c293), committed 2026-08-11.
- Only OpenAI-owned documentation and OpenAI's source repository are used below. The desktop shell itself is not part of the cited open-source repository, so conclusions about its private launch wiring are deliberately limited to what the official docs promise.

## Executive findings

| Question                                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket and Unix transports           | App Server supports one startup-selected local transport: `stdio://` (default), `ws://IP:PORT`, `unix://` or `unix://PATH`, or `off`. Unix is WebSocket-over-UDS, including the HTTP Upgrade handshake. `wss://` is accepted by remote clients, but the server-side `--listen` parser accepts only `ws://`; TLS must be terminated outside App Server.                                                                                                                                                |
| Multiple simultaneous clients           | **Yes for WebSocket, Unix socket, and Remote Control; no for stdio.** WebSocket/Unix acceptors create a distinct `ConnectionId` and writer queue per connection. The server keeps maps of all active connections. The source explicitly calls stdio `single_client_mode`.                                                                                                                                                                                                                             |
| Thread subscriptions                    | A loaded thread can have many subscribed connections. `thread/start`/`thread/fork` auto-subscribe; `thread/resume` of an already-loaded thread atomically adds the new connection, returns the live snapshot, and replays outstanding server requests such as approvals. Events go to all subscribed connections.                                                                                                                                                                                     |
| Thread writer ownership                 | There is **no exclusive client-connection writer owner inside one App Server runtime**. Any initialized client that knows a loaded thread id can call direct-input methods; the turn handlers resolve the thread by id and do not check that the caller created or subscribed to it. The exclusive writer lock is instead **cross-runtime/process**: one local runtime holds a filesystem lock for the live thread recorder, and a competing runtime gets `thread ... already has an active writer`.  |
| Approval ownership with several clients | Approval/user-input requests are sent to every subscribed connection with the same server request id. App Server stores one callback per request id, so the first valid response consumes it; later responses cannot find the callback. A relay must therefore coordinate which client is authoritative for approvals.                                                                                                                                                                                |
| Proxy/control socket                    | `codex app-server proxy` is a raw byte bridge from stdin/stdout to an already-listening Unix control socket. It is not an App Server, does not convert JSONL to WebSocket, and does not create a new network listener. The caller still speaks the WebSocket upgrade and framing protocol through the bridge.                                                                                                                                                                                         |
| Managed daemon                          | The experimental Unix-only daemon launches a separate, pid-managed App Server on the default Unix control socket, optionally with the official Remote Control relay enabled. It is for standalone/SSH-managed installations, not an adoption layer for an arbitrary desktop-owned process.                                                                                                                                                                                                            |
| Already-running desktop app             | Officially, the running desktop app can enable **Remote** from Settings, which creates secure relayed access without public exposure. There is no official documentation or open-source runtime API for adding a second arbitrary `ws://` or Unix listener to an already-running process. If the App-owned process was already launched on a Unix socket, another client can attach; if it was launched on stdio, the open-source server cannot retrofit a local listener without a restart/relaunch. |

## 1. Transport model

The public App Server documentation lists four modes:

- `stdio://`: newline-delimited JSON, default;
- `ws://IP:PORT`: one JSON-RPC message per WebSocket text frame, experimental and unsupported;
- `unix://` or `unix://PATH`: WebSocket over the default control socket or a custom Unix socket;
- `off`: no local transport.

Source: [official App Server documentation, “Protocol”](https://learn.chatgpt.com/docs/app-server).

The source representation is a single enum, not a list of listeners: `Stdio`, `UnixSocket`, `WebSocket`, or `Off`. The parser accepts only one `--listen` value and only server-side `ws://`, not `wss://`. See [`app-server-transport/src/transport/mod.rs#L74-L159`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/mod.rs#L74-L159) and the CLI's singular `listen: AppServerTransport` field in [`cli/src/main.rs#L522-L571`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/cli/src/main.rs#L522-L571).

At startup, App Server performs one `match` over that enum and starts exactly one local acceptor. Remote Control is started separately afterward, so the official relay may coexist with that one local transport. See [`app-server/src/lib.rs#L711-L816`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/lib.rs#L711-L816).

For TCP WebSocket, the official docs require TLS and bearer authentication for a non-local connection and describe plain WebSocket as appropriate only for localhost or SSH forwarding. They also call WebSocket transport experimental and unsupported. Source: [official App Server documentation, “Connect the CLI terminal UI” and “Protocol”](https://learn.chatgpt.com/docs/app-server).

## 2. One runtime accepts multiple clients

### Local WebSocket and Unix socket

Both connection-oriented acceptors are multi-client:

- The Unix acceptor loops over `listener.accept()`, spawns a task per accepted stream, performs a WebSocket upgrade, and passes the connection to the shared WebSocket connection runner. See [`app-server-transport/src/transport/unix_socket.rs#L24-L91`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/unix_socket.rs#L24-L91).
- The TCP listener uses Axum's connection-serving loop; every upgrade calls `run_websocket_connection`. That function allocates a new `ConnectionId`, outbound queue, and disconnect token, then emits `ConnectionOpened`. See [`app-server-transport/src/transport/websocket.rs#L105-L229`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/websocket.rs#L105-L229).
- The main server owns `HashMap<ConnectionId, ...>` collections for both per-connection protocol/session state and outbound writers. See [`app-server/src/lib.rs#L827-L880`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/lib.rs#L827-L880) and [`app-server/src/lib.rs#L911-L1013`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/lib.rs#L911-L1013).

By contrast, the startup code explicitly computes `single_client_mode` when the selected transport is stdio. Stdio represents the one parent/child pipe connection, not an acceptor. See [`app-server/src/lib.rs#L711-L725`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/lib.rs#L711-L725).

### Official Remote Control

Remote Control also multiplexes many logical clients into the same runtime. The relay protocol identifies each logical connection by `(client_id, stream_id)`. `ClientTracker` keeps a map of those pairs; an incoming `initialize` allocates a normal App Server `ConnectionId`, writer queue, and `ConnectionOrigin::RemoteControl`. See [`remote_control/client_tracker.rs#L34-L68`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/remote_control/client_tracker.rs#L34-L68) and [`remote_control/client_tracker.rs#L94-L216`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/remote_control/client_tracker.rs#L94-L216).

## 3. Thread subscriptions and writer ownership

### Many client subscriptions inside one runtime

`ThreadStateManager` models both directions explicitly:

- each thread owns a `HashSet<ConnectionId>`;
- each connection owns a `HashSet<ThreadId>`;
- adding or removing a connection updates both indexes.

See [`app-server/src/thread_state.rs#L302-L384`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/thread_state.rs#L302-L384) and [`app-server/src/thread_state.rs#L472-L590`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/thread_state.rs#L472-L590).

The official API documentation says `thread/start` automatically subscribes the caller, `thread/read` does not subscribe, and `thread/unsubscribe` removes only the current connection. The last-subscriber case begins a 30-minute idle grace period before unload. Source: [official App Server documentation, “API overview” and “Unsubscribe from a loaded thread”](https://learn.chatgpt.com/docs/app-server).

For an already-loaded thread, `thread/resume` is the multi-client join operation. The implementation:

1. detects the existing in-process thread rather than starting another recorder;
2. serializes the resume response with the live listener;
3. atomically adds the requesting `ConnectionId` to the thread;
4. returns persisted plus active-turn state;
5. replays outstanding server requests to the joining connection.

See [`thread_processor.rs#L3547-L3708`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/thread_processor.rs#L3547-L3708), [`thread_lifecycle.rs#L637-L662`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L637-L662), and [`thread_lifecycle.rs#L704-L755`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L704-L755).

The per-thread listener snapshots all subscribed connection ids for each core event and targets the translated notifications to that set. See [`thread_lifecycle.rs#L304-L348`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L304-L348).

### No exclusive connection-level writer

Inside a single runtime, App Server does not designate one connection as the thread's writer. `turn/start` and `turn/steer` resolve the `CodexThread` by `threadId` and submit input; they do not compare the caller's `ConnectionId` with a creator/owner field, nor require that connection to be in the subscription set. See [`turn_processor.rs#L320-L353`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/turn_processor.rs#L320-L353), [`turn_processor.rs#L474-L607`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/turn_processor.rs#L474-L607), and [`turn_processor.rs#L910-L1017`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/turn_processor.rs#L910-L1017).

This makes a one-runtime/multi-client relay mechanically viable, but it means the relay needs its own authorization and concurrency policy. App Server's thread id is not a connection-scoped write capability.

### Approval race among subscribers

Thread-scoped server requests are copied to every subscribed connection. One callback is stored under the shared server request id, and `notify_client_response` removes that callback before resolving it. Therefore the first response wins; subsequent responses log that no callback exists. See [`app-server/src/outgoing_message.rs#L295-L403`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/outgoing_message.rs#L295-L403).

This is not a desktop-versus-relay ownership protocol. A production relay should select one approval authority per thread/turn, deduplicate mirrored prompts, and fail closed on conflicting responses.

### Exclusive writer exists across runtimes/processes

The local thread store acquires an OS file lock at `CODEX_HOME/thread-writer-locks/<thread-id>.lock`. A competing lock returns `ThreadStoreError::Conflict` with `thread <id> already has an active writer`. See [`thread-store/src/local/writer_lock.rs#L17-L87`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/thread-store/src/local/writer_lock.rs#L17-L87).

Thread creation and cold resume acquire that lock before installing a live rollout recorder, and the recorder entry retains the guard for its lifetime. See [`thread-store/src/local/live_writer.rs#L25-L110`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/thread-store/src/local/live_writer.rs#L25-L110) and [`thread-store/src/local/mod.rs#L103-L120`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/thread-store/src/local/mod.rs#L103-L120).

Consequently, a second App Server process is not a substitute for a second client of the App-owned runtime when both need live write control of the same thread. The safe simultaneous topology is one runtime with multiple client connections.

## 4. Unix control socket and `app-server proxy`

The default socket is:

```text
$CODEX_HOME/app-server-control/app-server-control.sock
```

The path constants and resolver are in [`app-server-transport/src/transport/mod.rs#L54-L72`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/mod.rs#L54-L72). On Unix, the socket is created with mode `0600`; startup refuses to replace an active socket. See [`unix_socket.rs#L21-L43`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/unix_socket.rs#L21-L43) and [`unix_socket.rs#L93-L131`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/unix_socket.rs#L93-L131).

`codex app-server proxy [--sock PATH]` only chooses a socket path and calls the generic stdio-to-UDS relay. See [`cli/src/main.rs#L617-L675`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/cli/src/main.rs#L617-L675) and [`cli/src/main.rs#L1234-L1243`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/cli/src/main.rs#L1234-L1243). The relay copies bytes in both directions without protocol translation. See [`stdio-to-uds/src/lib.rs#L10-L45`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/stdio-to-uds/src/lib.rs#L10-L45).

Implications:

- `proxy` is useful when a parent process can only spawn a stdio child but needs to reach an existing Unix-socket App Server.
- It opens one ordinary client connection to an existing listener.
- It does not make a stdio-owned App Server attachable, add a socket to a running process, or turn the socket into a public endpoint.
- Because the Unix protocol is WebSocket-over-UDS, the bytes passed through `proxy` must include the WebSocket HTTP Upgrade and frames.

## 5. Managed daemon and official Remote Control architecture

### Managed daemon

The daemon README calls the feature experimental and says it is intended for Codex instances launched over SSH. It is Unix-only, uses pidfile-backed daemonization, and manages a standalone install under `CODEX_HOME`. Source: [`app-server-daemon/README.md`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-daemon/README.md).

The managed child always launches as one of:

```text
codex app-server --listen unix://
codex app-server --remote-control --listen unix://
```

See [`app-server-daemon/src/backend/pid.rs#L412-L434`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-daemon/src/backend/pid.rs#L412-L434).

Daemon state lives under `CODEX_HOME/app-server-daemon/` and includes settings, pid files, and a lifecycle lock. It can start, restart, stop, bootstrap, and persist Remote Control enablement. If it detects an App Server on the socket that is not its managed pid, mutating/restart flows reject it as “running but ... not managed by codex app-server daemon” rather than adopting it. See [`app-server-daemon/src/lib.rs#L253-L359`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-daemon/src/lib.rs#L253-L359) and [`app-server-daemon/src/lib.rs#L523-L585`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-daemon/src/lib.rs#L523-L585).

Therefore the daemon is a way to create a separately managed one-runtime/multi-client host. It is not a supported control plane for changing the transport of a desktop-owned App Server process.

### Remote Control relay

App Server creates a Remote Control task in addition to its selected local transport. When enabled, that task establishes an **outbound** WebSocket to the ChatGPT Remote backend, enrolls the host, and maps relayed logical clients into normal App Server connections. See [`remote_control/mod.rs#L932-L1084`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/remote_control/mod.rs#L932-L1084), [`remote_control/websocket.rs#L670-L771`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs#L670-L771), and the logical client mapping cited in section 2.

The source contains experimental JSON-RPC operations that enable or disable that outbound relay at runtime. They change the Remote Control desired state; they do not add a local WebSocket/Unix listener. See [`app-server/src/request_processors/remote_control_processor.rs#L20-L74`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/src/request_processors/remote_control_processor.rs#L20-L74) and [`remote_control/mod.rs#L249-L352`](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-transport/src/transport/remote_control/mod.rs#L249-L352).

Official documentation describes the product architecture at a higher level: Remote uses a secure relay so trusted machines remain reachable without direct public exposure; the connected host supplies chats, files, credentials, plugins, MCP, skills, browser access, Computer Use, sandboxing, and approvals. Source: [official Remote connections documentation, “What comes from the connected host”](https://learn.chatgpt.com/docs/remote-connections).

## 6. Can a running desktop app expose an extra listener?

### What is officially supported

Yes, an already-running desktop app can be configured as an **official Remote host**:

1. Open Settings > Connections > Control this Mac or PC.
2. Enable remote access and pair supported devices.
3. The host remains behind OpenAI's secure relay rather than exposing App Server directly.

The documented controllers are ChatGPT on iOS/Android and, when available, another Mac/Windows desktop app. Setup starts in the desktop app and cannot be performed from the Codex CLI or IDE extension. See [official Remote connections documentation, “Before you set up Remote” and “Set up Remote”](https://learn.chatgpt.com/docs/remote-connections).

### What is not supported or established

There is no primary-source evidence for a supported operation that tells an already-running desktop-owned App Server to add an arbitrary `ws://` or Unix listener:

- `--listen` is a singular startup argument.
- Runtime startup selects exactly one local transport.
- The only runtime transport toggle in the cited source controls the outbound official Remote relay.
- `app-server proxy` requires an already-existing Unix listener.
- The managed daemon starts or restarts its own managed process and refuses to reconfigure an unmanaged process.
- Official desktop documentation warns not to expose App Server transports directly on shared or public networks. See [official Remote connections documentation, “Authentication and network exposure”](https://learn.chatgpt.com/docs/remote-connections).

The precise local transport chosen by a particular desktop build is private desktop-shell behavior and is not promised by the open-source App Server documentation. Therefore a third-party relay must capability-detect an App-owned Unix/control socket rather than assume it exists.

The resulting decision is:

- **App-owned Unix socket is already accepting:** attach the relay as another client, call `initialize`, then `thread/resume` to join live threads. This is the only source-supported shape for simultaneous third-party and desktop clients in one local runtime.
- **App-owned runtime is stdio-only:** there is no supported hot-add listener operation. Use official Remote, or relaunch under a connection-oriented transport if the desktop host provides a supported way to do so.
- **Start a separate daemon/runtime:** this yields an attachable multi-client App Server, but it is not the desktop-owned runtime. Cross-process writer locks prevent both runtimes from live-owning the same thread, and desktop-injected native capabilities are not guaranteed to transfer.

## 7. Architecture consequence for Cognia

For a custom relay that must share active threads with the desktop UI, the source-backed target is:

```text
Desktop client ─┐
                ├─ WebSocket-over-UDS ─> one App-owned App Server ─> one live thread writer
Cognia broker ──┘                                  │
                                                   └─ events/requests fan out to subscribers
```

The broker should add policy that App Server intentionally does not provide at the connection level:

- authorize user/device/project/thread before forwarding a method;
- assign one turn/input authority at a time;
- assign one approval authority and deduplicate mirrored requests;
- use `thread/resume` for atomic subscription plus pending-request replay;
- use `thread/unsubscribe` on handoff/disconnect;
- never expose the raw App Server listener publicly.

If the App-owned runtime has no connection-oriented attachment point, the architecture is currently blocked at the ownership boundary. Transport tunneling or `app-server proxy` cannot turn a private stdio pipe into a second client connection.

## Primary sources

- [OpenAI: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI: Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [OpenAI Codex source, pinned commit](https://github.com/openai/codex/tree/3d4d253f8f4a812c595cd59e2c114c2c3696c293)
- [App Server README](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server/README.md)
- [App Server daemon README](https://github.com/openai/codex/blob/3d4d253f8f4a812c595cd59e2c114c2c3696c293/codex-rs/app-server-daemon/README.md)
