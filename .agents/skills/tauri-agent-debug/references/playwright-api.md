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
| Navigation | `goto`, `reload`, `goBack`, `goForward`, `waitForURL`, `waitForLoadState`, `waitForSelector`, `waitForFunction`, `waitForTimeout` | `networkidle` requires no captured fetch/XHR work for 500 ms |
| Semantic locators | `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId` | String/regex names, `exact`, and role state filters are supported |
| Locator actions | Page actions plus `tap`, `clear`, `pressSequentially`, `dragTo`, `scrollIntoViewIfNeeded` | Re-resolves before every operation and retries stale generation refs |
| Locator composition | `locator`, semantic nesting, `filter({ hasText, hasNotText })`, `first`, `last`, `nth`, `all` | Strict by default; negative `nth` indexes from the end |
| Input devices | `page.keyboard.{press,down,up,type,insertText}`, `page.mouse.{click,dblclick,move,down,up,wheel}` | Trusted DOM events are not available without CDP; events are synthetic |
| Diagnostics | `snapshot`, `evaluate`, `consoleMessages`, `networkEvents`, `nativeLogs`, `screenshot` | Console/network access is buffered; screenshot captures the native window |
| Dialogs | `installDialogHandler`, `getDialogs`, `clearDialogs` | Install before triggering alert/confirm/prompt |
| Network | `route`, `unroute`, `clearRoutes`, `getNetworkRequests`, `clearNetworkRequests` | Fetch can be mocked; fetch and XHR are captured; XHR mocking is not claimed |
| Windows | `window`, `targetWindow`, `listWindows`, `waitForWindow` | Scoped pages share endpoint authentication but target a different label |
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
- Auto-wait checks attached/visible/enabled/editable state. It does not claim
  Playwright's layout-stability or hit-target/receives-events checks; inspect
  `stablePositionCheck` and `receivesEventsCheck` when those semantics matter.
- `video: false` and `cdp: false`; `startRecording()` fails with
  `TauriDebugUnsupportedError` instead of silently producing incomplete data.
- `nativeScreenshot: true`; captures can include top-level window chrome and
  require OS screen-recording permission.

Use Cognia's Windows CDP E2E lane when a test requires trusted Chromium input,
Playwright tracing, browser contexts, response-body interception, downloads,
or video. Use this bridge when the requirement is the real Tauri process,
native command surface, system webview, multiple Tauri windows, or native logs.

## Structured snapshot refs

`page.snapshot()` returns generation-scoped refs such as `g3e7`. A ref is valid
only until the next snapshot. Normal locators hide this detail by resolving a
fresh ref before each operation and retrying a stale-ref race. CLI users must
use the snapshot returned by the most recent action.

Strict locators throw when more than one element matches. Use a semantic name,
nested locator, `filter`, `first`, or `nth` only when the ambiguity is
intentional.
