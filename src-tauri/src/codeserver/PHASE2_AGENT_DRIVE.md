# Pro IDE — Phase 2: Agent-drive (PENDING / not yet implemented)

Status: **design complete, not built.** Phase 0/1 (the human-usable embedded
code-server) is shipped and unit-tested; this document is the ready-to-implement
spec for making the **agent drive the code-server editor**. Approved plan:
`~/.claude/plans/replicated-nibbling-pony.md`. Deferred by request on 2026-07-14.

## Chosen scope

**Auto-follow (open + reveal) only.** When the agent reads or writes a file and
Pro IDE is the active editor for that project, code-server auto-opens that file
and scrolls to the touched line — you watch the agent work live. Editing still
goes through disk (code-server auto-reloads externally-changed files). We do
**not** (in this phase) stream edits as live `WorkspaceEdit`s, and do **not**
read the active editor back to the agent. Those were the two heavier options and
are explicitly out of scope here — see "Deferred extensions" below.

## The key finding that reshaped this phase (read first)

The agent has **no existing path to drive any editor** — not code-server, not
Monaco. Verified:

- The agent's write tool writes raw bytes to disk with Node fs:
  `sidecar/builtin-tools/file-ops/file-write.mjs` → `fsp.writeFile(path, bytes)`.
  No editor, no Tauri command, no event.
- The Project Editor only reflects disk out-of-band via `watchWorkspace`
  (`components/agent/workspace/editor/use-project-editor.ts`), which bumps a
  refresh token and flags `externallyChanged` for a **manual** reload.
- `lib/plugin/vscode-shim/monaco-bridge.ts` is the **wrong layer** — it is the
  ext-host↔Monaco LSP/provider plumbing on a _separate_ sidecar
  (`sidecar/vscode-ext-host/`), unrelated to the Claude agent host
  (`sidecar/claude-host.mjs`). It carries no agent→editor command direction, and
  its "active editor" tracking is global across all Monaco surfaces (Skills,
  Canvas, Artifact, Project) with no per-surface / agent scoping. **Do not put
  the authority switch here** (the original plan was wrong about this).

Consequence: agent-drive is **net-new for both editors**, which lets us build it
**once, unified**, and have it work for Monaco _and_ code-server.

## Architecture (unified through `project-editor-bridge`)

The one reusable renderer primitive is `lib/files/project-editor-bridge.ts`: a
registry of "open file at line" openers keyed by absolute project root. Today it
is fired only by terminal path-links (`components/terminal/terminal-instance.tsx`
→ `openInProjectEditor(abs,line,col)`) and search-panel jumps, and the Monaco
Project Editor registers its opener in
`components/agent/workspace/editor/agent-team-editor.tsx`
(`registerProjectEditorOpener({ root, open: gotoLine })`).

Plan:

1. **Authority = the existing `mode` toggle, via mount.** In
   `agent-team-editor.tsx` the `mode: "monaco" | "codeserver"` state already
   swaps the whole editor body. Make opener registration mode-aware:
   - `mode === "monaco"` → `ProjectEditorBody` registers the Monaco opener (today).
   - `mode === "codeserver"` → `CodeServerPane` registers a **code-server opener**
     (drives code-server via the WS channel below).
     Only one is mounted per root → `openInProjectEditor` routes to whichever
     editor is active. **No extra authority flag needed — mounting IS the
     authority** (recommendation from the design spike).

2. **Agent auto-follow.** Hook the agent's file activity to fire
   `openInProjectEditor(abs, line)`. The renderer already receives the agent's
   `tool_use` / `tool_result` events over `SIDECAR_EVENT`
   (`src-tauri/src/claude/sidecar.rs` → renderer chat stream). Add a small
   observer (renderer-side, gated on Pro IDE being active) that, on an agent
   file read/write tool event, extracts the file path (+ line if available) and
   calls `openInProjectEditor`. Because of (1) this drives whichever editor is
   active — Monaco or code-server — with one hook. **Find the exact renderer
   site that parses `tool_use` file-op events before wiring** (start from the
   chat message-parts that render file-op tools).

3. **Control channel = dedicated loopback WS owned by the `codeserver` module.**
   The companion axum server (`src-tauri/src/companion_api/`) is opt-in and not
   guaranteed running, so a core editor feature can't depend on it. Host a small
   loopback WS **in the codeserver module** so it comes up/tears down with the
   code-server process. Auth = **loopback-source check + per-instance shared
   token** (the fleet-token pattern in `src-tauri/src/fleet/routes.rs`, NOT
   device-JWT). Inject the token + WS port into code-server via the spawn env in
   `process.rs::code_server_args` / `spawn_child`. Structurally clone
   `src-tauri/src/companion_api/ws_terminal.rs`.

4. **Companion VS Code extension (`.vsix`)** installed into code-server, connects
   back to the WS, and executes the `openFile` command via the VS Code API.

## Pieces to build (in order)

### A. Rust loopback WS control channel — `src-tauri/src/codeserver/agent_channel.rs` (new)

- `AgentChannel` (add to `CodeServerState` or a sibling managed state): lazily
  start a loopback WS server (bind `127.0.0.1:0`), hold `token → root` and
  `root → conn-sender` maps + a `request-id → oneshot` correlation map.
- `register_instance(root) -> (ws_port, token)`: mint a token (use a real CSPRNG
  — check for `rand`/`getrandom`/`uuid` in `src-tauri/Cargo.toml`; do NOT use a
  counter), store `token → canonical root`, return for spawn-env injection.
- WS handler: on upgrade, verify loopback source, read a `Hello { token }` frame,
  map to root, store the connection sender.
- `send(root, method, params) -> Result<Value>`: correlate by id + `oneshot`,
  send the request frame, await with a timeout.
- Unit-test the pure parts: frame (de)serialization, token registry, request-id
  correlation, loopback-source rejection. (End-to-end needs the real shell.)
- Wire token+port into the spawn in `process.rs` (env, e.g.
  `COGNIA_CS_AGENT_WS` / `COGNIA_CS_AGENT_TOKEN`), and tear down on `stop`.

### B. WS protocol (frames)

```
// extension → app, once on connect
{ "type": "hello", "token": "<per-instance>" }
// app → extension
{ "type": "req", "id": 1, "method": "openFile",
  "params": { "path": "/abs/file.ts", "line": 42, "column": 1 } }
// extension → app
{ "type": "res", "id": 1, "ok": true }
{ "type": "res", "id": 1, "ok": false, "error": "..." }
```

Only `openFile` is needed for this phase (auto-follow). Keep the envelope generic
so `applyEdit` / `readActive` can be added later without a protocol change.

### C. Companion extension — `sidecar/codeserver-agent-ext/` (new)

- Minimal TS VS Code extension (`package.json` with `engines.vscode`, an
  `activationEvents: ["*"]` or `onStartupFinished`, `main` → bundled JS).
- On activate: read `COGNIA_CS_AGENT_WS` / `COGNIA_CS_AGENT_TOKEN` from
  `process.env`, dial the WS, send `hello`, then handle `req` frames:
  - `openFile`: `vscode.workspace.openTextDocument(path)` →
    `vscode.window.showTextDocument(doc, { selection: new vscode.Range(line-1,col-1,line-1,col-1) })`
    then `revealRange(..., InCenter)`.
- Bundle with esbuild to a single file; package to `.vsix` (vsce or a manual zip
  of the VSIX layout — a VSIX is a zip with `extension/` + `[Content_Types].xml`
  - manifest). Add the build to the sidecar build pipeline; ship the `.vsix` as a
    **Tauri resource** (`src-tauri/tauri.conf.json` bundle.resources) and resolve
    its path with the same `sidecar_dir` resolver code-server's LSP host uses.
- Install on first spawn (in `process.rs`, before/with the serve spawn):
  `code-server --install-extension <bundled.vsix> --extensions-dir <ours>`.
  Guard so it only runs once per version (marker file in the extensions dir).

### D. Frontend — driver + bridge routing

- `lib/codeserver/client.ts`: add `driveOpen(root, path, line, col)` →
  `transport.call("codeserver_agent_open", { root, path, line, column })`
  (new Rust command that calls `AgentChannel::send(root, "openFile", …)`).
- `components/agent/workspace/editor/code-server-pane.tsx`: register a
  code-server opener via `registerProjectEditorOpener({ root, open: (rel,line,col)
=> codeServerClient.driveOpen(root, join(root, rel), line, col) })` while
  mounted (mode === codeserver).
- `agent-team-editor.tsx`: make the existing `registerProjectEditorOpener`
  (Monaco arm) conditional on `mode === "monaco"` so the two never both register
  for one root.
- Agent auto-follow observer (see Architecture #2): new small hook/module,
  gated on Pro IDE active, that turns agent file-op tool events into
  `openInProjectEditor` calls.

### E. Tests

- Rust: `agent_channel.rs` in-file `#[cfg(test)]` — frame parse, token registry,
  loopback rejection, id correlation.
- Frontend: `code-server-pane` opener registration; the auto-follow observer
  (mock the event source + `openInProjectEditor`); `client.driveOpen` mapping.
- Sidecar/extension: a small `node --test` for the frame handling if factored
  out of the vscode-API call.
- End-to-end (open+reveal actually happening in code-server) is only verifiable
  in `pnpm tauri dev` — document it as a manual smoke step.

## Deferred extensions (out of scope for this phase)

- **Live `applyEdit`**: map the agent's file-write into a VS Code `WorkspaceEdit`
  so edits enter the undo stack / show as live diffs instead of disk reloads.
  Adds an `applyEdit` method + a file-write→edit mapping. Bigger.
- **Read active editor / selection back to the agent**: an `readActive` method +
  a way to surface it as agent context. Makes the channel bidirectional in the
  agent→context direction.
  The protocol envelope (B) is intentionally generic so both slot in later.

## Risks / open items

- **`.vsix` packaging + bundling** is the fiddliest part (build toolchain, Tauri
  resource, install-once marker, Open VSX has no bearing since we side-load).
- **Auto-follow event site**: confirm exactly where the renderer parses agent
  file-op `tool_use` events before wiring #2 (not yet pinned to a file).
- **Token CSPRNG**: verify a random source dep exists in `src-tauri`; never use a
  counter for the shared token.
- **Multiple roots / worktrees**: one code-server + one WS token per canonical
  root; the channel maps by root already.

## Reference: files this phase touches

New: `src-tauri/src/codeserver/agent_channel.rs`, `sidecar/codeserver-agent-ext/`.
Changed: `src-tauri/src/codeserver/{process,commands,mod}.rs`,
`src-tauri/src/lib.rs` (register the new command), `src-tauri/tauri.conf.json`
(bundle the `.vsix`), `lib/codeserver/client.ts`,
`components/agent/workspace/editor/{code-server-pane,agent-team-editor}.tsx`,
plus the new agent auto-follow observer.
Reused: `lib/files/project-editor-bridge.ts`,
`src-tauri/src/companion_api/ws_terminal.rs` (structural template),
`src-tauri/src/fleet/routes.rs` (loopback+token auth pattern),
`src-tauri/src/claude/sidecar.rs` (the agent event stream).
