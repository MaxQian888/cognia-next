# Playwright-style Tauri API

This client is a cross-platform, real-webview compatibility layer inspired by
Playwright and `tauri-playwright`. It intentionally exposes capabilities at
runtime instead of pretending WKWebView, WebView2, WebKitGTK, and Chromium CDP
are identical.

```js
import { connectTauriPage, expect } from "./scripts/tauri/agent-debug-client.mjs"

const page = connectTauriPage()
const capabilities = await page.capabilities()
await page.waitForLoadState("networkidle")
await page.getByRole("button", { name: "New chat", exact: true }).click()
await page.getByLabel("Message").fill("Hello from the real Tauri shell")
await expect(page.getByRole("button", { name: "Send" })).toBeEnabled()
await page.getByRole("button", { name: "Send" }).click()
await page.screenshot({ path: ".cache/tauri-agent-debug/chat.png" })
```

Run a saved script with `rtk node <script>.mjs`. Start the bridge first with
`rtk pnpm tauri:debug:agent` and stop it afterward.

## Compatibility contract

| Area | Supported interface | Semantics |
| --- | --- | --- |
| Page actions | `click`, `dblclick`, `hover`, `fill`, `type`, `press`, `check`, `uncheck`, `selectOption`, `focus`, `blur`, `dispatchEvent`, `dragAndDrop`, `setInputFiles` | Selector-level calls delegate to strict locators and auto-wait |
| Page queries | `textContent`, `innerHTML`, `innerText`, `allTextContents`, `allInnerTexts`, `inputValue`, `getAttribute`, `boundingBox`, `getComputedStyle`, `count` | Element queries auto-wait; `all*` and `count` allow zero matches |
| Page state | `isVisible`, `isHidden`, `isChecked`, `isDisabled`, `isEnabled`, `isEditable`, `isFocused` | Includes hidden attached nodes; visibility checks do not require actionability |
| Navigation | `goto`, `reload`, `goBack`, `goForward`, `waitForURL`, `waitForLoadState`, `waitForSelector`, `waitForFunction`, `waitForTimeout` | Uses document identity plus URL/readiness; `networkidle` requires no captured fetch/XHR work for 500 ms |
| Semantic locators | `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId` | String/regex names, `exact`, and role state filters are supported |
| Locator actions | Page actions plus `tap`, `clear`, `pressSequentially`, `dragTo`, `scrollIntoViewIfNeeded` | Resolves and acts atomically; supports `force`, `trial`, scroll policy, timeout, and abort signal |
| Locator composition | `locator`, semantic nesting, `and`, `or`, `filter({ has, hasNot, hasText, hasNotText, visible })`, `first`, `last`, `nth`, `all` | Strict by default; indexes apply to actions, reads, collections, states, and waits |
| Locator inspection | Standard queries plus `locator.waitForFunction` and `locator.ariaSnapshot` | Atomic with target resolution; `ariaSnapshot` emits compact AI-oriented semantic text |
| Input devices | `page.keyboard.{press,down,up,type,insertText}`, `page.mouse.{click,dblclick,move,down,up,wheel}` | Trusted DOM events are not available without CDP; events are synthetic |
| Diagnostics | `snapshot`, `evaluate`, `consoleMessages`, `networkEvents`, `readConsole`, `readNetwork`, `nativeLogs`, `screenshot` | Monotonic IDs and independent cursors prevent repeated or consumer-drained evidence |
| Dialogs | `installDialogHandler`, `getDialogs`, `clearDialogs` | Install before triggering alert/confirm/prompt |
| Network | `route`, `unroute`, `clearRoutes`, `getNetworkRequests`, `clearNetworkRequests` | Fetch can be mocked; fetch and XHR are captured; XHR mocking is not claimed |
| Windows | `window`, `targetWindow`, `listWindows`, `waitForWindow` | Scoped pages share endpoint authentication but target a different label |
| Renderer lifecycle | `rendererState`, `waitForRenderer`, `TauriDebugRendererRestartedError` | A web content process termination fails pending commands as restarted (codes `webview_renderer_restarted` / `webview_renderer_restarting`); `waitForRenderer` resolves once the reloaded renderer's helper answers |
| Assertions | `expect(locator)` state/text/value/attribute/CSS/count assertions and `expect(page).toHaveURL/toHaveTitle` | Polls until the page default timeout; `.not` is supported |

The assertion surface includes `toBeVisible`, `toBeHidden`, `toBeEnabled`,
`toBeDisabled`, `toBeEditable`, `toBeChecked`, `toBeFocused`, `toBeAttached`,
`toBeEmpty`, `toHaveCount`, `toContainText`, `toHaveText`, `toHaveValue`,
`toHaveAttribute`, `toHaveClass`, `toHaveId`, `toHaveCSS`, `toHaveURL`, and
`toHaveTitle`.

## Runtime capabilities

Always inspect `await page.capabilities()` when translating a suite that uses
browser-engine features. The current capability object reports:

- `networkMocking: "fetch-only"`; XHR remains observable but is not fulfilled
  by route mocks.
- `keyboard: "dom-events"` and `mouse: "dom-events"`; generated events have
  `isTrusted === false`.
- Auto-wait checks attached, visible, stable-position, hit-target/receives-events,
  enabled, and editable state. These remain synthetic webview checks rather
  than browser-engine trusted-input guarantees.
- Open shadow roots and same-origin frames are traversed with a bounded depth.
  Closed shadow roots and cross-origin frames remain unsupported.
- `video: false` and `cdp: false`; `startRecording()` fails with
  `TauriDebugUnsupportedError` instead of silently producing incomplete data.
- `nativeScreenshot: true`; captures can include top-level window chrome and
  require OS screen-recording permission.
- API version 3 revision 4 includes `locatorCompositionVersion: 2` for preserving
  indexed/filtered parent scopes when chaining locators. The client refuses
  these queries against an older helper before executing an action.
- `locatorActionControl: 1` is required for locator mutations. Only known
  failures marked `not-dispatched` are automatically retried. Renderer
  replacement is `retryable: false`, with outcome `unknown`; recover using
  `waitForRenderer` and reconcile persisted/external effects before retrying.
- Locator mutations and their follow-up waits consume one remaining budget.
  Cancellation fences dispatch and releases animation-frame waits; abort
  delivery is best effort and cannot undo a dispatched event, forcibly stop
  arbitrary evaluate code, or run while the renderer thread is blocked.
- Drag source/destination selection is one strict action, including destination
  filters and negative indices. Visibility queries and locator state waits
  reject multiple matches; zero matches remain valid for hidden/detached states.
- For delayed navigation, pass `click({ waitForURL: /\/settings$/, timeout:
  20_000 })` or explicitly wait for the URL. Strings match the complete URL;
  partial matching requires RegExp and glob syntax is unsupported. Readiness
  and destination waits share the action budget, and never replay its click.
- `locatorCollectionQueries: true` makes `count`, `allTextContents` and
  `allInnerTexts` read the full matched collection, subject to the bridge's
  existing result-byte limit. Text is not normalized or cut to snapshot length.
  Snapshot/node summaries remain bounded at 500 entries; an incomplete state
  query fails explicitly. Indexed node queries apply their index before that cap.
- `dispatchEventInit: true` preserves JSON event initialization fields and uses
  the target realm's DOM event constructor for standard event families. Unknown
  custom event names use `CustomEvent`, with explicit `eventInit.detail`.
  Missing constructors raise `TauriDebugUnsupportedError`. These events remain
  synthetic; browser default input behavior and `isTrusted` are not supplied.
- `diagnosticDocumentIds: true` makes cursors document-scoped. `consoleMessages()`
  and `networkEvents()` carry the document identity automatically. Raw readers
  must pass both returned values on the next read:

  ```js
  const batch = await page.readConsole()
  const next = await page.readConsole({
    after: batch.nextCursor,
    documentId: batch.documentId,
  })
  ```

  `cursorReset: true` means navigation or helper replacement invalidated the
  supplied document identity. `dropped` separately reports retained-buffer loss.
  This does not preserve events from a dead document; host-owned durable
  recording remains a separate capability.

Use Cognia's Windows CDP E2E lane when a test requires trusted Chromium input,
Playwright tracing, browser contexts, response-body interception, downloads,
or video. Use this bridge when the requirement is the real Tauri process,
native command surface, system webview, multiple Tauri windows, or native logs.

## Structured snapshot refs

`page.snapshot()` returns document-and-generation-scoped refs such as
`d<documentId>:g3e7`. A ref is valid only in that document incarnation and until
the next snapshot. Normal locators do not use refs: resolution,
index/strict selection,
actionability, and inspection/action execute atomically. CLI users must still
use the newest snapshot ref.

Strict locators throw when more than one element matches. Use a semantic name,
nested locator, `filter`, `first`, or `nth` only when the ambiguity is
intentional.

## Managed rebuild recovery

Managed launch metadata pins sessionId/workspace; appInstanceId/PID/endpoint/token
rotate with the native process. The client follows only its pinned discovery file
and authenticates replacement identity before another operation is sent. The
interrupted operation is not replayed. `reconnect({ timeout, signal })` and
`waitForRenderer({ timeout, signal })` wait within one budget. Fixed/manual
connections without managed identity require a fresh explicit attachment.

`TauriDebugSessionError` reports connection loss, app replacement or ownership
refusal. `TauriDebugDocumentReplacedError` reports ordinary document replacement
or a loading deadline. Both leave uncertain mutations non-retryable. Native
`documentEpoch`/`documentLoading` track normal reloads separately from renderer
crashes; `documentScopedRefs` prevents cross-document ref reuse. Unsaved UI state
and page-only evidence are not restored by reconnection.
