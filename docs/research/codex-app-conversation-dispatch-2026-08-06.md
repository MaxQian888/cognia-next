# Codex App conversation dispatch feasibility (2026-08-06)

## Decision

The feature is feasible without CDP and without starting a Codex model turn.

Use the running Codex App's documented local app-server control socket, then use
`externalAgentConfig/import` to create a normal persisted Codex thread from a
short-lived external-session export. Open the result with
`codex://threads/<threadId>`.

Do not use `thread/inject_items` as the primary import mechanism. It persists
model-visible history, but it does not create normal turns, so the imported
messages are not available to the App as a regular transcript and the empty
thread is omitted from normal thread listings.

## Verified environment

- PATH CLI: `codex-cli 0.145.0`
- Codex App bundled CLI: `codex-cli 0.147.0-alpha.1.2`
- Codex App bundle: `/Applications/ChatGPT.app`, bundle id `com.openai.codex`
- App control socket:
  `$CODEX_HOME/app-server-control/app-server-control.sock`
- Workspace used by the probes:
  `/Users/bytedance/Project/cognia-next`

## Primary-source findings

### Local control-plane transport

Codex app-server supports JSON-RPC over a WebSocket handshake on the default
Unix control socket. The upstream README explicitly describes this transport as
intended for local app-server control-plane clients. The socket path is derived
from `CODEX_HOME`.

The running Codex App was observed launching its bundled CLI with
`app-server --listen unix://`. A second client successfully connected to that
socket, completed the app-server `initialize` handshake, and issued requests
while the App remained connected.

### Visible session import

The documented `externalAgentConfig/import` method accepts a selected
`SESSIONS` migration item. Upstream Codex code converts external user and
assistant messages into persisted `TurnStarted`, user-message, agent-message,
response-item, token-count, and `TurnComplete` rollout entries. The upstream
integration test asserts that imported sessions:

- appear in `thread/list`;
- preserve title, cwd, preview, and timestamps;
- return normal turns from `thread/read(includeTurns: true)`; and
- can be resumed and followed by a normal Codex turn.

The import path does not call `turn/start`. It only parses and persists the
external transcript. Upstream also tests that session import does not initialize
required MCP servers.

### Deep link

The desktop App documents `codex://threads/<threadId>` as the canonical link for
opening an existing local task. `codex://threads/new` and `codex://new` can only
prefill a new composer; they cannot represent role-preserving existing turns.

## Real probes

### `thread/inject_items` probe

1. Started a new app-server thread.
2. Injected user/assistant/user Responses API message items.
3. Set a title and read the thread back.

Observed result:

- the rollout contained the injected response items;
- `thread/read(includeTurns: true)` returned `turns: []`;
- the thread was omitted from `thread/list`; and
- the App could address it by id, but exposed no normal transcript turns.

Conclusion: useful for hidden model context, not for a user-visible conversation
handoff.

### Spawned stdio app-server import probe

A temporary Claude-format session was imported through the existing PATH CLI's
stdio app-server. The resulting task had normal turns, preserved cwd, and was
resumable by the newer App runtime. However, the running App did not refresh its
task-list cache immediately, and the created thread inherited the spawned
runtime's `openai` provider rather than the App's active provider configuration.

Conclusion: a valid fallback, but not the preferred first-party App handoff.

### Live Codex App socket import probe

A second client connected directly to the running App's control socket and
imported a temporary session containing one user and one assistant message.

Verified result:

- CLI version came from the App bundle (`0.147.0-alpha.1.2`);
- model provider matched the App runtime (`aiden_aiproxy` in this environment);
- cwd and title were preserved;
- `thread/read` returned a completed normal turn with both messages;
- the task appeared immediately in the App task list;
- `codex://threads/<threadId>` opened it; and
- no model turn was started.

All probe threads and temporary source files were removed after verification.

## Recommended integration

### Reuse boundary

Reuse the existing app-server protocol work, but do not reuse the whole
`CodexAppServerAdapter` instance for App control:

- reuse `JsonRpcPeer`, wire/error conventions, title handling, and version
  negotiation from `lib/ai/agent/external/codex-app-server-client.ts`;
- keep the existing adapter's stdio/process-owning lifecycle for Cognia-managed
  Codex agents;
- add a sibling App-control connection using WebSocket-over-Unix-socket. It must
  never kill or otherwise own the Codex App process.

This prevents lifecycle bugs while avoiding a second JSON-RPC implementation.

### Dispatch flow

1. Read the Cognia session and resolve its effective cwd.
2. Serialize rich message parts with the existing handoff serializer.
3. Exclude Cognia system messages and credentials; preserve user/assistant text
   and render tool/file parts as bounded textual markers.
4. Create an owner-only, uniquely named, short-lived Claude-session JSONL under
   the external-session detection root, including a `custom-title` record.
5. Connect to the live Codex App control socket. If the App is not running,
   launch it with a canonical deep link and retry the socket for a bounded time.
6. Call `externalAgentConfig/import`, wait for the matching completed
   notification, and extract the imported thread id.
7. Call `thread/name/set`, then verify `thread/read(includeTurns: true)` has
   turns and the expected cwd. Delete the new thread if verification fails.
8. Remove the temporary source file in a `finally` path.
9. Open `codex://threads/<threadId>`.

Use a shared in-flight promise keyed by Cognia session id so the header button
and sidebar action cannot create duplicate snapshots from a double click. Once
the operation completes, a later click intentionally creates a new snapshot.

## Security and compatibility requirements

- Verify the socket belongs to the current OS user before transmitting the
  transcript; keep the control directory and temporary source owner-only.
- Do not copy Cognia system prompts, environment variables, API keys, SDK
  session ids, or live approval/runtime state.
- Treat the imported Codex rollout as the durable copy; remove the temporary
  external-session file even when import or deep-link opening fails.
- Version-gate `externalAgentConfig/import` and report an explicit update error
  on method-not-found. Do not silently fall back to CDP.
- The app-server surface can evolve, so generate/version-check schemas in tests
  and keep a real Tauri smoke test against the installed App.
- Imported history ends with Codex's standard `<EXTERNAL SESSION IMPORTED>`
  marker. This is produced by Codex itself and should not be rewritten by
  Cognia.

## Why not CDP

CDP would require a debug-enabled App, bind behavior to private DOM/state
details, broaden the local attack surface, and still fail to create canonical
Codex turns reliably. The app-server control plane provides typed persistence,
role fidelity, cwd metadata, versioned errors, and the official deep-link path.

## Sources

- [Codex App Server documentation](https://developers.openai.com/codex/app-server)
- [Codex desktop deep-link reference](https://learn.chatgpt.com/docs/reference/commands#deep-links)
- [Codex app-server transport README](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/app-server/README.md)
- [External-session rollout conversion](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/external-agent-migration/src/sessions/export.rs)
- [App-server session-import integration test](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/app-server/tests/suite/v2/external_agent_config.rs#L1515)
- [External-agent import protocol types](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L704)
