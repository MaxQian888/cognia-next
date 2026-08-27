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
node scripts/tauri/agent-debug.mjs act g1e4 click
node scripts/tauri/agent-debug.mjs act g2e7 fill "hello"
node scripts/tauri/agent-debug.mjs console
node scripts/tauri/agent-debug.mjs network
node scripts/tauri/agent-debug.mjs logs --lines 200
node scripts/tauri/agent-debug.mjs screenshot .cache/tauri-agent-debug/main.png
```

Snapshots return generation-scoped accessibility references such as `g1e4`.
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

## Stop

```bash
pnpm tauri:debug:agent:stop
```

`stop` first verifies that the live bridge PID belongs to the tracked session,
then asks Cognia to exit cleanly and terminates the tracked dev process group if
the Tauri supervisor remains alive. It refuses shutdown when ownership cannot
be proven.
