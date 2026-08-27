# Browser Use extension requirement and upstream architecture

**Date:** 2026-08-26  
**Scope:** Browser Use `0.13.8`, the current official Browser Harness path, local Chrome/CDP, optional bundled extensions, Browser Use Cloud, and the architectural value of a Cognia-owned Chrome extension.  
**Sources:** Primary sources only: Browser Use documentation, tagged source, release notes, first-party architecture writing, and Chrome extension documentation.

`0.13.8`, published 2026-08-16, is the latest stable Browser Use release at the research cutoff. ([release](https://github.com/browser-use/browser-use/releases/tag/0.13.8))

## Executive conclusion

Browser Use does **not** require Cognia to build a browser-control extension from `browser-extension-starter`.

The supported local control plane is Chrome DevTools Protocol (CDP): Browser Use either launches a Chromium browser with a debugging endpoint, attaches to a running Chrome/Chromium endpoint, or accepts an arbitrary local/remote `cdp_url`. Browser Use Cloud exposes the same kind of CDP endpoint for a managed remote browser. The official `0.12.3` CLI release stated this directly: the CLI “doesn't require a Chrome extension.” The current `0.13.8` skill still defines Browser Use as “Direct browser control via CDP” and says its normal local flow attaches to the running Chrome/Chromium CDP endpoint. ([Browser Use `0.13.8` skill](https://github.com/browser-use/browser-use/blob/0.13.8/skills/browser-use/SKILL.md#L24-L76), [Browser Use CLI 2.0 release](https://github.com/browser-use/browser-use/releases/tag/0.12.3))

Browser Use does load some Chrome extensions by default in browser instances it launches, but those are **optional automation helpers**, not the Browser Use transport. They reduce ads/cookie interruptions and keep new tabs in the background; the setting can be disabled, and download/setup failures are logged and skipped. ([`BrowserProfile.enable_default_extensions`](https://github.com/browser-use/browser-use/blob/0.13.8/browser_use/browser/profile.py#L637-L644), [extension loading implementation](https://github.com/browser-use/browser-use/blob/0.13.8/browser_use/browser/profile.py#L1010-L1104))

A Cognia extension can still be worthwhile, but only as an optional **browser-native product and bridge layer**: a side panel, one-click current-tab handoff, explicit consent/status, active-window access, and browser-permission-backed capabilities. It should not become a prerequisite for Browser Use itself.

## Cognia and sibling-starter findings

The current Cognia tree does not depend on the `browser-use` Python package or CLI. It already has three distinct browser paths:

1. `EmbeddedEngine` drives the Tauri WebView for local development previews.
2. `RemoteChromiumEngine` calls Cognia's private Companion RPC surface; Playwright and CDP remain inside `WorkspaceRuntime`.
3. The built-in `playwright-existing-browser` MCP preset starts `@playwright/mcp@latest --extension`, using Microsoft's official Playwright extension to let the user authorize selected Chrome or Edge tabs and reuse their existing login state.

These are visible in [`lib/browser/agent-engine.ts`](../../lib/browser/agent-engine.ts), [`lib/browser/remote-chromium-engine.ts`](../../lib/browser/remote-chromium-engine.ts), [`plugins/playwright-mcp/src/index.ts`](../../plugins/playwright-mcp/src/index.ts), [ADR-0055](../content/docs/en/adr/0055-agent-browser-loop.md), and [ADR-0085](../content/docs/en/adr/0085-cloud-shared-browser.md). Therefore a Cognia-owned extension would be a fourth integration surface, not a missing prerequisite for the existing engines.

The new Companion browser-access listener is also not an automation extension transport. It lets a normal web client on an explicitly allowed HTTP(S) origin pair with and call the local Host over `http://127.0.0.1`; DPoP device authentication remains required. Its saved origin validator currently accepts only exact HTTP(S) origins, so a future `chrome-extension://<id>` client needs an explicit origin/authentication design rather than being assumed to fit the current allowlist. See [`src-tauri/src/companion_api/browser_access.rs`](../../src-tauri/src/companion_api/browser_access.rs), [`src-tauri/src/companion_api/web_origin.rs`](../../src-tauri/src/companion_api/web_origin.rs), and the [headless service-plane documentation](../content/docs/en/subsystems/companion-api/headless-service-plane.mdx).

The sibling `/Users/bytedance/Project/browser-extension-starter` is useful scaffolding, but its current code is not a browser automation bridge:

- WXT builds Chrome MV3 and Firefox MV2 packages and already provides React popup, side-panel, options, DevTools, new-tab, content-script, storage, typed messaging, auth, CI, and manifest checks.
- Its Chrome manifest requests `storage`, `sidePanel`, and `<all_urls>` host access. It does not request `debugger`, `nativeMessaging`, `scripting`, or tab-capture permissions.
- Its background worker only queries the active tab and asks the content script for `{title, url}`; the content script injects a demonstration button. There is no CDP relay, DOM snapshot/action protocol, tab lease, Cognia pairing, or reconnect/backpressure implementation.
- Supabase authentication and OpenPanel analytics are starter-specific choices and should not be carried into a Cognia extension without a separate product and privacy decision.

Reusing the starter would therefore save packaging and extension-UI setup, not the hard browser-control work.

## What the official architecture actually uses

| Surface                                                 | Browser transport                                                                  | Extension required? | Relevant behavior                                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser Use CLI / Browser Harness, local                | Direct CDP to the running Chrome/Chromium browser                                  | No                  | Uses the user's existing logged-in browser. If Chrome is running without remote debugging, setup opens `chrome://inspect/#remote-debugging`; macOS may also require approval. |
| Browser Use Python API, managed local browser           | Browser Use launches Chrome/Chromium with a debugging port, then connects over CDP | No                  | Can run headed/headless, use a temporary profile, select a profile, or load storage state.                                                                                    |
| Browser Use Python API, existing or third-party browser | Caller supplies an HTTP or WebSocket `cdp_url`                                     | No                  | Works with any reachable Chromium CDP provider.                                                                                                                               |
| Browser Use Cloud browser                               | Managed remote Chromium plus returned `cdp_url` and `live_url`                     | No client extension | Adds browser isolation, proxies/stealth, live preview, recording, and optional persistent profiles.                                                                           |
| Browser Use default helper extensions                   | Chrome `--load-extension` launch flags                                             | Optional            | Improves page cleanliness and tab focus; it is not how the agent sends browser commands.                                                                                      |

The current stable skill describes the local flow as a persistent daemon attaching to the running Chrome/Chromium CDP endpoint. It can work in background tabs and still exposes raw `cdp("Domain.method")`; the same document recommends cloud browsers when local parallel tasks would fight over tabs/focus. ([Browser Use `0.13.8` skill](https://github.com/browser-use/browser-use/blob/0.13.8/skills/browser-use/SKILL.md#L36-L85))

The Python API separately supports both a locally launched `Browser(...)` and `Browser(cdp_url="http://remote-server:9222")`; it can also auto-detect system Chrome profiles. ([Browser configuration reference](https://github.com/browser-use/browser-use/blob/0.13.8/skills/open-source/references/browser.md#L12-L32), [system Chrome/profile API](https://github.com/browser-use/browser-use/blob/0.13.8/skills/open-source/references/browser.md#L105-L115), [remote CDP URL](https://github.com/browser-use/browser-use/blob/0.13.8/skills/open-source/references/browser.md#L201-L237))

At source level, `BrowserSession.connect()` resolves an HTTP endpoint through `/json/version` and creates a root CDP WebSocket client. When Browser Use launches a local browser itself, it adds `--remote-debugging-port` and requires a non-default `--user-data-dir` before attaching. ([`BrowserSession.connect()`](https://github.com/browser-use/browser-use/blob/0.13.8/browser_use/browser/session.py#L1831-L1905), [`LocalBrowserWatchdog`](https://github.com/browser-use/browser-use/blob/0.13.8/browser_use/browser/watchdogs/local_browser_watchdog.py#L95-L150))

These details matter for integration: an extension is not a drop-in replacement for `cdp_url`. Browser Use currently expects a browser-level HTTP/WebSocket CDP endpoint and root target/session semantics.

## What “Browser Use extensions” means upstream

There are three different concepts that can be confused:

### 1. Optional helper extensions in locally launched Chromium

`enable_default_extensions` defaults to true and can be disabled with `BROWSER_USE_DISABLE_EXTENSIONS=1`. In the `0.13.8` implementation, Browser Use attempts to download and unpack:

- uBlock Origin Lite;
- “I still don't care about cookies”;
- Force Background Tab.

The source catches setup errors and continues, which demonstrates that these extensions are not required for the browser session. The field description still mentions ClearURLs, but the tagged implementation's actual list contains Force Background Tab instead; the implementation is the reliable description of what is loaded in this release. ([profile setting](https://github.com/browser-use/browser-use/blob/0.13.8/browser_use/browser/profile.py#L637-L651), [actual extension list and non-fatal setup](https://github.com/browser-use/browser-use/blob/0.13.8/browser_use/browser/profile.py#L1010-L1104))

Their benefits are narrow and operational: fewer ads and cookie banners in the agent's DOM/screenshot context, plus more stable tab focus. They do not pair Cognia with Chrome, transport agent commands, or expose the user's current tab.

### 2. The user's existing Chrome extensions

When Browser Use attaches to an already-running real Chrome, it inherits that browser's logins, cookies, tabs, and installed extensions. That still uses CDP for automation; Browser Use does not require one particular Browser Use extension. The `0.12.3` release documented `--connect`, `--profile`, and `--cdp-url`, and explicitly contrasted the CLI with the Claude Chrome extension. ([Browser Use CLI 2.0 release](https://github.com/browser-use/browser-use/releases/tag/0.12.3))

Browser Use also excludes `chrome-extension://` pages from normal target processing by default, reducing the chance that an extension side panel is mistaken for the website being automated. ([target filtering](https://github.com/browser-use/browser-use/blob/0.13.8/browser_use/browser/session.py#L3655-L3705))

### 3. Browser-extension APIs inside the broader BU Agent product

Browser Use's first-party architecture article says BU Agent starts with raw CDP and layers browser-extension APIs on top because some tasks—such as reading the active window or accessing permissioned browser state—are awkward or impossible through CDP alone. It describes CDP and extension APIs as complementary action spaces. ([Browser Use, “The Bitter Lesson of Agent Frameworks,” BU Agent section](https://browser-use.com/posts/bitter-lesson-agent-frameworks#bu-agent-the-application))

That supports building an extension for additional capabilities, but it does not make an extension a dependency of the open-source Browser Use CLI or Python API. It is evidence for a hybrid product architecture, not for replacing Browser Use's CDP execution layer.

## Local browser and CDP capabilities

The official local path already provides most capabilities normally sought from a control extension:

- navigation, tabs, clicks, keyboard input, DOM and accessibility-tree inspection;
- screenshots and JavaScript evaluation;
- access to the user's existing logged-in Chrome when attaching to the real browser;
- raw CDP methods for browser/page/network/runtime operations;
- local persistent daemon semantics so repeated commands reuse one browser connection;
- background-tab operation without visibly switching the user's active tab in the normal case.

The trade-offs are:

- the supported browser family is Chrome/Chromium, not Safari or Firefox;
- local Chrome must expose/allow remote debugging;
- one real local Chrome is shared state, so parallel tasks can contend for tabs and focus;
- attaching to or launching a real profile has locking and security constraints; the Python reference tells callers to close Chrome when directly opening the same profile, while the Browser Harness path attaches to the already-running instance instead. ([Browser Use skill](https://github.com/browser-use/browser-use/blob/0.13.8/skills/browser-use/SKILL.md#L51-L85), [real-browser Python reference](https://github.com/browser-use/browser-use/blob/0.13.8/skills/open-source/references/browser.md#L173-L197), [Browser Use CLI 2.0 release](https://github.com/browser-use/browser-use/releases/tag/0.12.3))

## Browser Use Cloud capabilities

Cloud is an alternative browser host, not an extension distribution mechanism.

Browser Use Cloud can return a `cdp_url` for raw automation and a `live_url` for viewing or embedding the session. Its documented browser infrastructure provides a hardened Chromium fork with stealth/anti-fingerprinting, residential proxies, isolated sessions, optional recordings, and profile-backed persistence. ([CDP with Playwright/Puppeteer](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium), [live preview and recording](https://docs.browser-use.com/cloud/browser/live-preview), [residential proxies](https://docs.browser-use.com/cloud/browser/proxies), [cloud quick start](https://docs.browser-use.com/cloud/quickstart))

Cloud profiles can persist cookies, localStorage, and saved passwords across cleanly stopped sessions. The separate local-to-cloud profile-sync flow uploads cookies; Browser Harness's first-party profile-sync reference is explicit that it does **not** sync localStorage, IndexedDB, or extensions. ([cloud profiles](https://docs.browser-use.com/cloud/guides/authentication), [profile sync guide](https://docs.browser-use.com/cloud/guides/profile-sync), [Browser Harness profile-sync details](https://github.com/browser-use/browser-harness/blob/6bb1c847fd62638554618e8d1e03247b935ff9cf/interaction-skills/profile-sync.md#L72-L76))

Cloud is strongest for isolated or parallel work, bot-sensitive sites, proxies, and hosted operation. It does not solve the “control exactly this user's current local tab with visible in-browser UX” use case; that is where a Cognia extension may be valuable.

## What a Cognia extension would add

The strongest reasons to reuse `browser-extension-starter` are product reasons, not Browser Use runtime requirements.

### Unique benefits

1. **Persistent in-browser UI.** A Chrome side panel can remain alongside the page, be scoped per site/tab, and access extension APIs. That is suitable for task status, approval, pause/resume, handoff, and “run on this tab” affordances. ([Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel))
2. **Current-tab and browser-state semantics.** An extension can identify the active window/tab and use permissioned Chrome APIs without inferring visible state from CDP target order. This matches the gap identified by Browser Use's own BU Agent architecture article. ([Browser Use architecture article](https://browser-use.com/posts/bitter-lesson-agent-frameworks#bu-agent-the-application))
3. **An alternate CDP transport.** `chrome.debugger` can attach to tabs and issue supported CDP commands without exposing a conventional remote-debugging WebSocket port. ([Chrome `debugger` API](https://developer.chrome.com/docs/extensions/reference/api/debugger))
4. **A controlled bridge to Cognia.** Chrome Native Messaging provides an extension-to-native application channel, allowing a Tauri/native host to receive explicit tab/task handoffs. ([Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging))
5. **Clearer user agency.** A toolbar action or side-panel gesture can define the point at which a user grants control of a specific tab, which is easier to explain than a machine-wide debugging endpoint.

### Costs and limitations

1. **It is not plug-compatible with Browser Use.** `chrome.debugger` is a JavaScript extension API, while Browser Use expects an HTTP/WebSocket CDP endpoint. Cognia would need to implement and maintain a protocol adapter, target/session mapping, event forwarding, reconnect behavior, and backpressure.
2. **The CDP surface is restricted.** Chrome documents that `chrome.debugger` exposes only an allowlisted subset of CDP domains for security reasons. ([Chrome `debugger` API](https://developer.chrome.com/docs/extensions/reference/api/debugger))
3. **The permission is highly sensitive.** Chrome's install warning for `debugger` says the extension can access the page debugger backend and read/change all data on all websites. The permission therefore creates a substantial trust, privacy, and security burden. ([Chrome permissions reference](https://developer.chrome.com/docs/extensions/reference/permissions-list))
4. **Native Messaging is another installed component.** The host must be registered per operating system, allowed origins must match the extension ID, and the bridge protocol must be secured and versioned. ([Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging))
5. **A second control path increases complexity.** Direct CDP, extension `chrome.debugger`, cloud CDP, and potentially content scripts can disagree about active tabs, ownership, and lifecycle unless Cognia defines one authority.
6. **It remains Chrome-family-specific.** Building the extension does not add Safari or Firefox support to Browser Use.

The conclusion that an extension could remove the manual remote-debugging setup is an architectural inference: Chrome officially defines `chrome.debugger` as an alternate CDP transport, but Browser Use does not provide an extension bridge that converts it into the root WebSocket connection expected by `BrowserSession`. Cognia would own that bridge.

## Recommendation for Cognia

Use Browser Use/CDP as the required execution layer and keep the extension optional.

For controlling existing logged-in Chrome or Edge tabs today, first use Cognia's existing `playwright-existing-browser` preset. It already delegates browser authorization, selected-tab access, Manifest V3 lifecycle, and the extension transport to the official Playwright implementation. A custom extension should supersede that path only if Cognia needs product-owned tab handoff, approvals, page-context capture, or browser-resident task UX that the official bridge cannot provide.

### Do not build the extension yet if the goal is only

- run Browser Use locally from Cognia;
- automate a managed Chromium profile;
- connect to an already-debuggable local Chrome;
- connect to Browser Use Cloud or another CDP provider;
- reuse cookies/logins through a profile or storage-state workflow.

For those cases, an extension duplicates an already supported transport and adds distribution, permissions, security, and lifecycle work.

### Build an extension when Cognia needs

- a browser-resident side panel and approvals;
- one-click “use this tab” semantics;
- explicit per-tab user handoff and live task status;
- active-window or permissioned browser state unavailable through the chosen CDP path;
- local Chrome control without asking users to enable the Browser Harness remote-debugging setting;
- a durable product presence in Chrome independent of whether the Cognia desktop window is visible.

If built, the extension should be a **thin control/UX plane**:

```text
Cognia UI / agent runtime
  -> authenticated Tauri/native bridge
  -> optional Cognia Chrome extension
  -> chrome.debugger + tab/side-panel APIs
  -> current user-selected Chrome tab

Browser Use runtime
  -> direct CDP for managed/local/cloud browsers
```

Do not fork Browser Use around the extension or make the extension mandatory for every browser session. Define a narrow adapter contract—attach selected tab, detach, stream CDP events, send CDP command, report active-tab metadata, request/revoke control—and retain direct CDP as the baseline and fallback.

If the first extension milestone is only “Ask Cognia about this page” plus task status, prefer `activeTab` and optional host permissions over the starter's always-on `<all_urls>` content script. Add `chrome.debugger` only when a proven workflow requires native CDP-class control; Chrome does not allow that permission to be requested optionally, and its warning materially changes the extension's trust posture.

## Decision summary

- **Required to use Browser Use:** no custom extension.
- **Official baseline:** direct CDP to local, existing, or cloud Chromium.
- **Official built-in extensions:** optional page/focus helpers, not the control bridge.
- **Best immediate Cognia path:** integrate Browser Use through direct CDP and prove the real local flow.
- **Existing-browser path already in Cognia:** Microsoft's official Playwright extension through `playwright-existing-browser`.
- **Reason to adopt `browser-extension-starter`:** first-class Cognia-owned Chrome UX, user-selected current-tab handoff, and Chrome extension APIs that complement CDP.
- **What the starter saves:** extension packaging, cross-context UI, typed messaging, and CI—not automation or Cognia authentication.
- **Architectural guardrail:** keep the extension an optional adapter/control plane, not a Browser Use dependency.
