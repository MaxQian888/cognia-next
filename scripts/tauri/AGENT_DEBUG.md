# Agent-friendly Tauri debugging

This debug path drives Cognia's real Tauri webviews on macOS, Windows, and
Linux. It complements the Windows WebView2 CDP Playwright suite; it does not
replace that suite or pretend that a system webview implements Chromium CDP.

## Start and discover

```bash
pnpm tauri:debug:agent
pnpm tauri:debug:agent:status
```

`launch` starts `tauri dev` with the opt-in `agent-debug` Cargo feature, waits
for the authenticated loopback bridge, and prints JSON containing the process,
artifact directory, native log path, and live windows. The session record lives
under `.cache/tauri-agent-debug/`; normal Tauri builds do not compile the debug
routes.

The API v3 status report distinguishes missing/stale endpoints, normal builds,
helper mismatches, authentication failures, tracked-process exits, and session
ownership mismatches. Cargo/Tauri terminal markers in `tauri-dev.log` abort a
launch immediately instead of consuming the full cold-build timeout.

The bridge reuses Cognia's per-launch `cli-endpoint.json` token and rejects
non-loopback clients. Treat that file as a session credential. Raw renderer
evaluation and screenshots are intentionally unavailable without the feature.

## Observe, act, then observe again

```bash
node scripts/tauri/agent-debug.mjs snapshot --include-text
node scripts/tauri/agent-debug.mjs act '<ref-from-latest-snapshot>' click
node scripts/tauri/agent-debug.mjs act '<ref-from-latest-snapshot>' fill "hello"
node scripts/tauri/agent-debug.mjs console
node scripts/tauri/agent-debug.mjs network
node scripts/tauri/agent-debug.mjs logs --lines 200
node scripts/tauri/agent-debug.mjs screenshot .cache/tauri-agent-debug/main.png
```

Snapshots return document-and-generation-scoped accessibility references such
as `d<documentId>:g1e4`.
Every action also returns a fresh snapshot. Always use a reference from the
latest snapshot; stale refs fail instead of accidentally acting on a different
element after React rerenders.

Supported actions are `click`, `dblclick`, `focus`, `hover`, `fill`, `type`,
`press`, `check`, `uncheck`, `select`, and `scrollIntoView`. Use `--value` for
form actions and `--key` for `press`. Target another Tauri webview with
`--window <label>`.

For diagnosis that cannot be expressed as an accessibility action:

```bash
node scripts/tauri/agent-debug.mjs evaluate "document.location.href"
node scripts/tauri/agent-debug.mjs reload
```

`evaluate` is a debugging escape hatch, not a test assertion API. Prefer
snapshot refs for repeatable flows.

For multi-step flows, import the Playwright-shaped client instead of scripting
HTTP calls:

```js
import { connectTauriPage } from "./scripts/tauri/agent-debug-client.mjs"

const page = connectTauriPage()
await page.waitForLoadState("networkidle")
await page.getByRole("button", { name: "New chat" }).click()
await page.getByLabel("Message").fill("hello")
await page.screenshot({ path: ".cache/tauri-agent-debug/flow.png" })
```

The client provides strict atomic `TauriLocator` semantics, role/text/label/CSS
locators, relative composition, actions, actionability checks, navigation
identity, `waitFor*`, `ariaSnapshot`, evaluation, screenshots, and cursor-based
console/network evidence. Locator operations resolve and execute in one webview
evaluation and therefore do not invalidate one another's snapshot generations.
See the project skill at
`.agents/skills/tauri-agent-debug` for the agent workflow and full API matrix.

API version 3 revision 4 preserves indexed/filtered parent scopes in nested
locators and advertises `locatorCompositionVersion: 2`. If the client refuses a
scoped query against an older running helper, restart the tracked debug shell
before using that query; it will not silently drop the parent selection.

Console/network batches include `documentId` and `cursorReset`. The convenience
readers carry document identity automatically. For explicit cursor management,
pass both the previous batch's `nextCursor` as `after` and its `documentId` to
`readConsole` / `readNetwork`. A document change resets the cursor within the same
read, so low IDs in the new document are not skipped. Legacy numeric reads remain
accepted; events buffered only in a destroyed renderer cannot be recovered.

The `locatorCollectionQueries` capability reads complete counts/text separately
from bounded snapshots. `count()` does not stop at 500, and the collection text
methods retain whitespace and full string lengths. Indexed state queries select
the requested node before applying the snapshot cap. The existing 2 MiB result
limit still applies; old capped helpers and incomplete state results fail
explicitly instead of returning a misleading partial result.

The `dispatchEventInit` capability passes JSON initialization fields to the
matching DOM event constructor in the target realm. It preserves explicit
`bubbles`, keyboard/mouse fields and custom-event `detail`; it does not make
events trusted or provide browser default input behavior. Older helpers are
refused before dispatch. A target detached during actionability checks is
retryable before dispatch, including when `force` is requested.

API version 3 revision 4 retains `locatorActionControl: 1`. Locator actions require
this capability before dispatch. Each attempt has a request ID; only known
locator failures explicitly marked `not-dispatched` may auto-retry. A renderer
restart, transport failure, or ambiguous timeout never replays a mutation.
Repeated IDs are refused within their retained deadline; this is a bounded
guard, not durable exactly-once execution across reloads.

Locator actions, inspections, navigation, URL/function waits, locator waits,
and renderer recovery share their caller's remaining budget across retries and
follow-up waits. The bridge accepts up to 120 seconds per request instead of
silently imposing the old 10-second evaluation and 15-second transport caps.
An absolute expiry derived from the remaining budget fences queued locator
actions; active waits use local monotonic deadlines. Aborting an in-flight
locator action sends a best-effort cancellation by ID. Native timeout cleanup
marks its retained control cancelled before deleting the result slot, and
shared core version 3 can release a suspended animation-frame stability check.
The helper checks cancellation, expiry, attachment and both drag endpoint
identities immediately before dispatch. Cancellation cannot roll back events
already dispatched, and cannot forcibly terminate arbitrary `evaluate` code or
a blocked JavaScript thread. `dispatchState: "dispatched"` means the mutation
function was entered and can include a partial event sequence; `unknown` must
be reconciled before submitting another mutation.

Drag destination filters, `nth` and `last` are resolved with the source inside
the same action. Ambiguous destinations fail strictness; hidden, detached,
unstable or obscured destinations block applicable actions. A forced action
still checks attachment and endpoint identity. Single-element visibility
queries and all four locator wait states are strict; zero matches remain
valid for `isVisible()` (false), `isHidden()` (true), hidden and detached waits.

An action cannot infer navigation scheduled at an arbitrary future time. State
the expected destination for delayed SPA/document navigation:

```js
await page.getByRole("link", { name: "Settings" }).click({
  waitForURL: /\/settings$/,
  waitUntil: "load",
  timeout: 20_000,
})
```

The action and destination wait consume one budget; a failed destination wait
does not re-click the link. `waitForURL` also supports independent waits, exact
URL strings, RegExp matchers and AbortSignal. Strings no longer use substring
matching; use a RegExp for partial matching. Playwright glob patterns are not
implemented. Immediate navigation metadata remains available for ordinary
actions; it does not promise that delayed navigation was observed.

## Renderer restarts

On macOS the WKWebView web content process can die (killed from Activity
Monitor, OOM, a crash) while the app process stays alive. Cognia handles
`webViewWebContentProcessDidTerminate` itself: it records a new renderer
generation for that window and reloads it (the main window reloads to its
last-known-good route and shows the existing "recovered" notice; after more
than three terminations within two minutes it stops reloading).

The bridge follows the replacement renderer instead of staying bound to the
dead one:

- a command in flight when the renderer dies fails immediately with
  `503 webview_renderer_restarted` (with `window` and `rendererGeneration`)
  instead of waiting out a 10 s `webview_eval_timeout`;
- the next command waits up to 10 s for the replacement document, re-injects
  the helper, and runs normally; if the reload never commits it fails with
  `webview_renderer_restarting`;
- `/api/dev/agent/health` reports `renderers` (per-window `generation` and
  `awaitingLoad`) without blocking on a reload.

The CLI prints `code`, `rendererGeneration`, and `rendererRestarted: true` for
these failures. The client throws `TauriDebugRendererRestartedError`, also when
an evaluation timeout straddled a termination; recover with
`await page.waitForRenderer()` and take a fresh snapshot, because refs and
in-page state from the old renderer are gone.
The error has `retryable: false` and `dispatchState: "unknown"`. Persisted or
external effects may survive the old renderer; inspect those effects before
retrying the mutation after recovery.

## Recompilation, process replacement and document reloads

Managed launches assign a `sessionId` and canonical workspace to the `tauri dev`
run. Its replacement app processes inherit that identity and each generate a
new `appInstanceId`. Authenticated health and endpoint discovery expose the
same `debugSession` record with the actual app PID. Each run also writes a
private endpoint file in its artifact directory, alongside the regular CLI
discovery file. Both discovery and the launcher record are replaced atomically.
Another Cognia instance overwriting regular discovery does not retarget the
managed client or shutdown command.

The client pins its discovery file, session and workspace. Before a subsequent
command, changed discovery is verified against authenticated health before
adopting the new port/token/app instance. App replacement resets local diagnostic
cursors. An interrupted command fails with `TauriDebugSessionError`
(`debug_connection_lost` or `debug_app_restarted`), with an unknown outcome;
it is never automatically replayed. Explicit recovery is also available:

```js
await page.reconnect({ timeout: 120_000, signal })
await page.waitForRenderer({ timeout: 120_000, signal })
```

Reconnection and page readiness consume the remaining caller budget. A session,
workspace, PID or app-instance disagreement fails before any operation is sent
to the discovered app. Fixed/manual endpoints without managed identity cannot
silently adopt a new process. Existing legacy runs require one controlled
relaunch to acquire this metadata; no existing running session was restarted
by an explicit launch/stop/restart command while writing these patches. An
already-running watcher may independently react to source edits.

Launcher `status`, reuse and `stop` use the stable session/workspace identity
instead of requiring the original app PID. Stop pins the validated endpoint
through shutdown. `waiting_for_app` means the managed supervisor is alive but
the bridge is unavailable; `waiting_for_page` means the app is reachable while
its page loads. These states do not assert that a compiler job is running.
If stop cannot authenticate ownership while the app is unavailable, it keeps
refusing destructive cleanup.

Native `documentEpoch` advances on ordinary full-page loads independently of
renderer crash generation. `documentLoading` stays true until the load finishes.
Pending evaluations/polls fail as `webview_document_replaced`; readiness waits
surface `webview_document_loading` when their budget expires. The client exposes
both as `TauriDebugDocumentReplacedError`, without automatic mutation replay.
Page departure cancels cooperative locator waits and clears refs; back/forward
cache restoration gets a fresh document identity. The `documentScopedRefs`
capability prevents an old `g1e1` from aliasing a different document's `g1e1`.
Refresh/reconnection does not restore unsaved UI state or page-only evidence.

To deliberately keep the native app stable while editing Rust, start a new run
with `rtk node scripts/tauri/agent-debug.mjs launch --no-watch`. This disables
Rust watching for that run; frontend HMR/reloads still follow the frontend dev
server. An existing watching run is not silently switched or restarted to apply
this option.

## Stop

```bash
pnpm tauri:debug:agent:stop
```

`stop` first verifies that the live bridge PID belongs to the tracked session,
then asks Cognia to exit cleanly and terminates the tracked dev process group if
the Tauri supervisor remains alive. It refuses shutdown when ownership cannot
be proven.
