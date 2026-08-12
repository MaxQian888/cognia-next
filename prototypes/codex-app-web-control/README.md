# Codex App Web control prototype

> Disposable implementation under `prototypes/`. It uses private desktop behavior and is not a
> supported Codex API.

## Proven architecture

The Browser-compatible route keeps the desktop App's normal runtime completely intact. Cognia Web
does not attach another App Server client and does not replace the bundled CLI.

```text
Cognia Web
  ├─ typed command envelope ──── loopback authenticated HTTP
  │   ├─ tasks and composer ───── loopback CDP ── Codex App renderer
  │   └─ files and folders ────── private cache ── renderer host message
  └─ live display ───────────── SSE projection of App-owned rollout JSONL

Codex App
  └─ bundled codex app-server (normal direct child)
       └─ normal plugins, MCP, skills, Browser/IAB, and Computer Use hosts
```

This is still one runtime: the App owns the only live App Server and its task store. CDP performs
only App UI gestures. The Web bridge reads the App-owned rollout files and projects user messages,
assistant messages, task lifecycle, and tool lifecycle.

Live verification on 2026-08-12 passed all of these gates:

- exactly one normal App-owned child:
  `codex -c features.code_mode_host=true app-server --analytics-default-enabled`;
- no `CODEX_CLI_PATH`, relay shim, shared daemon, or `app-server --listen` process;
- CDP bound only to `127.0.0.1:9229`;
- a Cognia-created App task used the installed in-app Browser, read a random local code, and returned
  `BROWSER_RELAY_OK 3001F71F56702D41`;
- the Web mirror observed the Browser tool lifecycle and exact final answer;
- after the user switched to another App task, a follow-up reopened
  `codex://threads/<canonical-thread-id>`, verified the rendered conversation ID, submitted through
  the target composer, and mirrored `THREAD_BOUND_FOLLOWUP_OK` from the correct rollout.

The expanded control surface was live-verified on 2026-08-12 as well:

- a Web-uploaded TXT entered the native App composer and the App read its marker;
- that same App-owned task used Browser and returned
  `ATTACHMENT_BROWSER_OK ATTACHMENT_RELAY_OK_6F21C4A8 6D6256971A50F22F`; CDP independently read
  `6D6256971A50F22F` from the App's Browser target;
- after switching the visible App task, a file-bearing follow-up returned
  `SWITCHED_THREAD_ATTACHMENT_OK ATTACHMENT_RELAY_OK_6F21C4A8` from the original task;
- a Web-selected folder was reconstructed in the private cache and appeared in the App as the
  native `fixtures / Folder` attachment card;
- App context discovery enumerated Goal, Plan mode, Browser, Computer, Documents, PDF,
  Spreadsheets, Presentations, Sites, Record & Replay, Figma, GitHub, and the other currently
  installed/dynamic items; invoking `Browser` produced a real plugin mention in the composer.

## Optional manual relaunch

Run the read-only checks first:

```bash
pnpm --dir prototypes/codex-app-web-control test
pnpm --dir prototypes/codex-app-web-control cdp:dry-run
```

`cdp:web` now performs this check and recovery automatically. To exercise only the detached restart
worker, without starting the Web bridge, arm it explicitly:

```bash
pnpm --dir prototypes/codex-app-web-control cdp:arm
```

The detached worker waits 15 seconds, asks Codex App to quit gracefully, and waits up to three
minutes for a manual `Cmd+Q` if macOS declines the request. It reopens the App with only:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9229
```

It then verifies the renderer, loopback listener, and normal App-owned App Server child. Any failure
after the App exits triggers a normal-App rollback. If the App never exits, the experiment is
cancelled without changing the running App.

## Start the Cognia bridge

```bash
pnpm --dir prototypes/codex-app-web-control cdp:web
```

This command installs the loopback Relay itself as a user-scoped `launchd` service, prints its
fragment-token URL, and reuses the same healthy service on later runs. Stop only the Relay with:

```bash
pnpm --dir prototypes/codex-app-web-control cdp:web:stop
```

Stopping the Relay does not quit or relaunch Codex App.

Before listening, the bridge checks the exact Codex App process, the `127.0.0.1:9229` listener, the
real Codex renderer target, and the normal App-owned App Server child. If CDP is missing, it first
submits a detached, user-scoped `launchd` worker; only that worker asks the running App to quit
gracefully, reopens it with the two loopback CDP switches shown above, and verifies the complete
runtime. The restart therefore survives termination of the App and of any App-owned terminal that
initiated it. CDP-dependent commands repeat the gate, so a later normal App restart is recovered on
the next command instead of waiting for the old 15-second target timeout. Concurrent callers join
the active worker and cannot trigger duplicate restarts.

The bridge fails closed if multiple App processes exist, the CDP port belongs to an unknown process,
or the listener is not loopback-only. A failed relaunch automatically restores a normal App without
CDP. For diagnosis, disable recovery with `--no-auto-restart`, or change the readiness window with
`--cdp-ready-timeout-ms <15000..180000>`.

The default task workspace is the Cognia repository root. Override it with
`CODEX_RELAY_WORKSPACE=/absolute/path` or `--workspace /absolute/path`.

The command prints a fragment-token URL and a one-time pairing code:

```text
Cognia normal-App control: http://127.0.0.1:4317/#<token>
Cognia Web pairing code: <pairing-code>
```

The included page can list and search App tasks, copy canonical UUIDs, upload files and folders,
create/select/open/stop tasks, send thread-bound messages, discover and invoke current App
contexts/plugins, stream mirrored events, and execute the generic command envelope.
A Cognia dev page on `http://127.0.0.1:3000` or `http://localhost:3000` can pair locally:

```ts
const descriptor = await fetch("http://127.0.0.1:4317/api/pair", {
  method: "POST",
  headers: { "X-Cognia-Pairing-Code": pairingCode },
}).then((response) => response.json())

const headers = {
  Authorization: `Bearer ${descriptor.token}`,
  "Content-Type": "application/json",
}

const taskIndex = await fetch(
  `${descriptor.baseUrl}/api/tasks?scope=workspace&archived=active&query=${encodeURIComponent("title or UUID")}`,
  { headers: { Authorization: `Bearer ${descriptor.token}` } }
).then((response) => response.json())

for (const item of taskIndex.tasks) {
  console.log(item.id, item.title)
}

const attachment = await fetch(`${descriptor.baseUrl}/api/attachments`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${descriptor.token}`,
    "Content-Type": file.type || "application/octet-stream",
    "X-Attachment-Name": encodeURIComponent(file.name),
    "X-Attachment-Size": String(file.size),
  },
  body: file,
}).then((response) => response.json())

const task = await fetch(`${descriptor.baseUrl}/api/commands/execute`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    command: "task.create",
    input: {
      prompt: "Read the attachment and use the installed Browser plugin.",
      browserUrl: "https://example.com/",
      attachmentIds: [attachment.id],
    },
  }),
}).then((response) => response.json())

const events = new EventSource(
  `${descriptor.baseUrl}/api/events?token=${encodeURIComponent(descriptor.token)}`
)
events.addEventListener("snapshot", handleSnapshot)
events.addEventListener("mirror", handleEvent)
```

## Command system

`GET /api/commands` returns the live catalog, including JSON-schema-shaped input metadata and flags
such as `mutates`, `destructive`, and `supportsAttachments`. Every mutation is serialized and every
execution emits `command/started`, `command/completed`, or `command/failed` with a request ID.

| Command                   | Behavior                                                          |
| ------------------------- | ----------------------------------------------------------------- |
| `runtime.status`          | Read App/CDP/task/cache status                                    |
| `attachment.list`         | List safe attachment metadata without local paths                 |
| `attachment.delete`       | Delete one private cached file or folder                          |
| `task.list`               | List/search canonical task UUIDs, titles, and safe metadata       |
| `task.create`             | Create an App-owned task with Browser URL and attachments         |
| `task.select`             | Bind the mirror to an existing canonical task and open it         |
| `task.open`               | Open and verify the exact canonical task                          |
| `task.send`               | Send a thread-bound message with optional attachments             |
| `task.attach`             | Attach files/folders without submitting                           |
| `task.interrupt`          | Click only the exact task `Stop` control                          |
| `composer.context.list`   | Discover the current Add menu, plugins, pages, and recent sources |
| `composer.context.invoke` | Invoke one exact item returned by context discovery               |

The old `/api/task` and `/api/follow-up` routes remain compatibility wrappers around `task.create`
and `task.send`; they no longer implement separate behavior.

## Task index and canonical UUIDs

The relay opens `~/.codex/state_5.sqlite` in read-only mode and reads the desktop App's authoritative
`threads` index. It does not scrape the sidebar, open a second App Server runtime, or read a task's
private rollout contents. The visible title uses the user-assigned `name` first, then the generated
`title`, then the preview. Each result includes the canonical `id` accepted by `task.select`, plus
safe metadata such as preview, workspace, timestamps, archived/pinned state, source, and model.

`GET /api/tasks` accepts these query parameters:

- `scope=workspace|all` (default `workspace`);
- `archived=active|archived|all` (default `active`);
- `query=<text>` to search UUID, title, name, preview, first user message, or workspace;
- `includeSubagents=true|false` (default `false`);
- `limit=1..200` and an opaque `cursor` for deterministic pagination.

The same operation is available through `POST /api/commands/execute` with command `task.list`. The
page exposes all filters, `Copy UUID`, `Select`, and `Load more`. By default it shows only active,
non-subagent tasks in the configured Cognia workspace.

If the SQLite index is temporarily unavailable, the relay falls back to
`~/.codex/session_index.jsonl` and marks the response `degraded: true`; that fallback provides only
UUID, saved thread name, and update time, so workspace and archive filtering cannot be exact.

## Attachment lifecycle

- Files are streamed as raw request bodies; folders are uploaded with
  `POST /api/attachment-folders` followed by member streams to
  `/api/attachment-folders/<id>/files`.
- The built-in page selects exactly one folder through macOS Standard Additions and imports it via
  `POST /api/attachment-folders/select`. It contains no `webkitdirectory` input, so Chromium never
  displays an “upload all files from this folder” warning. The member-stream endpoints remain
  available for a remote Cognia Web client that cannot use the local native picker.
- Nested members are reconstructed inside one root, while the attachment list and Codex composer
  receive one directory item. A failed import removes the incomplete directory atomically.
- The Web client can never supply an arbitrary local path. It receives opaque attachment IDs, and
  only paths created inside the relay's private cache can reach the App.
- Cache directories are mode `0700`, files are mode `0600`, names and relative paths are sanitized,
  traversal is rejected, and cache contents are removed when the relay exits.
- Multiple files and folders are supported. Defaults are 20 top-level items, 1,000 files per
  folder, 25 MiB per file, and 100 MiB total per relay process.
- Attachment IDs resolve to file descriptors inside the private cache. The relay delivers those
  descriptors through the App renderer's existing `add-context-file` host-message path, preserves
  the trailing-slash directory convention, and verifies that each new attachment card appeared.
  The App still owns attachment state, prompt serialization, and downstream plugin/tool access.

`POST /api/follow-up` is fail-closed. It requires the canonical `threadId` captured from the rollout,
opens `codex://threads/<threadId>`, waits until the App DOM renders that same canonical ID, selects
only the real Codex composer, and accepts only exact `Send`, `Queue`, `Submit`, or `Run` controls.
It will not submit into whichever conversation happens to be visible.

## Security boundary

- Both CDP and the Web bridge bind only to loopback.
- API access uses a random 256-bit bearer token; Cognia pairing also requires a per-process code.
- Browser CORS is limited to configured Cognia localhost origins.
- Request bodies are bounded; the rollout projection excludes raw internal records.
- Attachment delivery does not automate the native macOS file panel and therefore does not require
  Accessibility permission. The relay still fails closed if the exact task is not selected or the
  App does not render the expected number of new attachment cards.
- CDP is unauthenticated Chromium debugging. Never port-forward or expose ports 9229 or 4317.
- The bridge can drive the App UI with the user's local authority. A production build needs explicit
  local pairing UX, task-level authorization, audit logs, and rate limits.

Return to a launch without CDP:

```bash
pnpm --dir prototypes/codex-app-web-control cdp:rollback
```

## Rejected runtime-sharing approaches

The older implementations remain in this directory only as research evidence:

- transparent `CODEX_CLI_PATH` shim: protocol mirroring worked, but App-owned IAB registration
  disappeared;
- `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` plus a shared UDS App Server: two logical clients and shared
  task events worked, but IAB was unavailable even to normal desktop conversations;
- direct public App Server WebSocket: experimental, unsupported, and unnecessary for this route.

Both invasive approaches restored Browser immediately after returning to a normal App launch. They
must not be used for the Browser-compatible Cognia integration.
