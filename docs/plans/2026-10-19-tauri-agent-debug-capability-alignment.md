# Align Tauri agent debugging through explicit guarantees and platform backends

| Field                 | Value                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status                | Proposed architecture; the separately authorized first bug-fix batch is edited but unverified                                                                      |
| Date / author         | 2026-10-19 / Codex                                                                                                                                                 |
| Request               | Separate existing bugs from new underlying capabilities; define platform paths, priorities, delivery and acceptance                                                |
| Depth                 | Heavy: Node client, injected JavaScript, Rust/native APIs, process lifecycle, local evidence and CI                                                                |
| Source baseline       | HEAD `e8ceb2b2cb2a513c99d7119121be3634db422173` was observed during research; the shared working tree also contains unrelated changes                              |
| Current authorization | Implement confirmed bugs first. Do not execute tests, type checks, lint, builds, browser probes or live Tauri flows until the user confirms the verification scope |
| Review roles          | Desktop automation maintainer; native platform maintainers; observability maintainer; testing maintainer; security reviewer                                        |
| Related decision      | [ADR-0102: unified observability and crash diagnostics](../content/docs/en/adr/0102-unified-observability-crash-diagnostics.md)                                    |

## 1. Preserve the bridge, fix its contract, and add stronger backends explicitly

**Recommendation:** keep the authenticated real-WebView bridge and its semantic API, correct the confirmed defects, then add capability-specific native and engine backends. A Playwright-shaped method must never imply a guarantee its selected backend cannot provide.

The existing implementation already has strict atomic locators, actionability checks, multiple windows, bounded diagnostic buffers and renderer recovery. The research reproduced five groups of correctness defects and several limits intrinsic to synthetic input. Additional DOM event patches cannot supply engine input, debugger stacks, complete network capture or crash-safe evidence.

Reuse `cognia-automation` for desktop input/coordinate handling and `cognia-observability` for privacy, trace context, spool and package formats. Windows can expose a genuine Playwright Page over the existing WebView2 CDP route. macOS and Linux must retain their actual system WebViews and report different available guarantees.

The first bug-fix batch is authorized and edited. New backend implementation, interface-breaking migration and live verification remain outside that batch. Review decisions Q1–Q4 close the remaining architecture choices; no phase is considered accepted merely because an API exists.

## 2. Evidence distinguishes reproduced defects, source facts and proposals

Evidence labels used throughout this document:

- **Reproduced:** the pre-change injected scripts were exercised in an isolated Chrome page during the earlier research turn. This is evidence about script behavior, not a claim about WKWebView or the real Tauri shell.
- **Source-confirmed:** owning source/configuration was inspected; the corresponding runtime path has not necessarily been exercised.
- **Proposed:** target behavior, budgets or implementation choices that have not shipped.
- **Gate:** evidence or review needed before a capability may be advertised.

Before the user introduced the verification hold, `rtk pnpm tauri:debug:agent:test` passed 31 Node tests and 11 jsdom tests. Those results belong to the pre-change baseline. They do not validate the current edits. No test or live verification command has been executed for the new changes.

The earlier status probe reported `bridge_unavailable`; the existing tracked session was not restarted or stopped. This document makes no current live-session health claim.

The inspected lockfile versions were Tauri 2.12.0, Wry 0.57.0, the Rust `webkit2gtk` binding 2.0.2, Enigo 0.6.1 and xcap 0.9.8. The `webkit2gtk` crate version is not the installed system WebKitGTK version. `package.json` declares `@playwright/test` `^1.63.0`; implementation must use the resolved lockfile version and record the actual browser/WebView runtime version in evidence.

## 3. Correctness bugs and missing capabilities have different completion criteria

Priority describes delivery order: **P0** restores trustworthy operation/evidence; **P1** supplies the main debugging workflow; **P2** adds advanced platform coverage; **P3** needs a separate feasibility or platform gate. It does not imply a production incident severity.

### 3.1 Confirmed bugs can be corrected within the existing bridge

| ID  | Priority / evidence   | Defect and owner                                                                                                                                         | Required correction                                                                                                                                                                                         | Acceptance                                                                                                                                                              |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 | P0 / reproduced       | Console/network IDs restart per document while `TauriPage` retains old numeric cursors                                                                   | Pair the cursor with document identity; reset atomically in the helper when identities differ; keep console/network consumers independent                                                                   | After reading ID 3 in document A, document B's ID 1 is returned once; explicit independent reads still work; retention loss and reset remain distinguishable            |
| B02 | P0 / reproduced       | `_append` loses parent `nth` and applies parent predicates at the descendant stage                                                                       | Preserve ordered parent selection in the locator query tree; reject unsupported query versions before executing an action                                                                                   | Parent filter/index, negative index, chained narrowing, union/intersection and relative filters preserve their selection stages; ambiguity is still strict              |
| B03 | P1 / reproduced       | Hit testing returns the shadow host and rejects its actual button                                                                                        | Descend open shadow roots and evaluate composed ancestry without bypassing real overlays                                                                                                                    | Nested open-shadow button clicks once; document/shadow overlays block it; closed roots are not falsely advertised                                                       |
| B04 | P1 / reproduced       | Top-realm constructors/setters reject iframe textarea controls                                                                                           | Use the element's owning realm for setters, constructors and visibility traversal                                                                                                                           | Same-origin iframe input/textarea/select operations work; input events belong to that realm; hidden ancestors still prevent applicable actions                          |
| B05 | P1 / reproduced       | Number/search roles and descendant image names diverge from semantic locators                                                                            | Correct those mappings and name-from-content behavior; exclude hidden decorative descendants                                                                                                                | `spinbutton`, `searchbox`, and a button named by an image's `alt` match the regression fixtures; no assertion of complete AccName conformance                           |
| B06 | P0 / source-confirmed | Collection methods consume bounded node summaries, losing matches above 500, whitespace and text above 500 characters; indices are applied after the cap | Add dedicated full collection reads; apply state-query indices in the helper before bounding summaries; reject incomplete results                                                                           | Count/text fixtures with 601 matches and long strings remain complete; nth(600) resolves; legacy ambiguous capped results fail explicitly                               |
| B07 | P1 / source-confirmed | Generic dispatch always creates CustomEvent and nests all supplied fields in detail                                                                      | Use target-realm constructors for DOM event families and preserve JSON EventInit fields; gate legacy helpers before mutation                                                                                | Mouse/key fields, bubbles=false and explicit custom detail reach listeners; unsupported constructors are explicit; events remain untrusted                              |
| B08 | P0 / source-confirmed | A target detached during scrolling or actionability can still receive a programmatic action through its stale reference                                  | Recheck attachment before dispatch, including forced actions; return retryable only before the side effect                                                                                                  | Deterministic detachment during scroll causes zero clicks and a retryable not_attached result                                                                           |
| B09 | P0 / source-confirmed | Renderer replacement is marked retryable and `_act` can replay a mutation whose persisted effects survived                                               | Retry only an allowlisted locator failure explicitly marked not-dispatched; preserve uncertain outcomes and require reconciliation after renderer recovery                                                  | A click followed by renderer replacement issues one mutation; transport/post-navigation failures never replay it                                                        |
| B10 | P0 / source-confirmed | Result-slot deletion does not cancel pending work; per-stage timeouts reset or exceed the caller budget                                                  | Share the remaining deadline across client retries/navigation and native bind/start/poll; cancel by request ID; retain a cancellation control and fence queued dispatch; release suspended stability checks | Cancellation/expiry during either animation frame causes zero clicks; late completion cannot recreate a deleted result; budgets decrease across attempts and waits      |
| B11 | P1 / source-confirmed | Drag destination resolution is separate from source dispatch and silently selects the first destination after DOM changes                                | Resolve both endpoints in one helper action; preserve destination filters/index; enforce strictness, actionability and final identity checks                                                                | Ambiguous/hidden/detached/replaced/retargeted destinations dispatch no dragstart; filtered last destination is selected within the same trial action                    |
| B12 | P2 / source-confirmed | isVisible/isHidden and locator waits accept multiple matches while other single-element methods are strict                                               | Request strict state queries and preserve valid zero-match semantics for hidden/detached states                                                                                                             | All four wait states reject ambiguity; visibility false and hidden true remain valid with zero matches                                                                  |
| B13 | P2 / source-confirmed | Immediate navigation metadata misses navigation scheduled after action completion; URL/function waits lose cancellation                                  | Add an explicit expected destination to actions; wait for URL and readiness within the action budget; propagate cancellation                                                                                | A delayed destination requires multiple reads and one click; failed/cancelled navigation waits never replay the completed click                                         |
| B14 | P1 / source-confirmed | TauriPage retains the old port/token after a Rust rebuild replaces the app process                                                                       | Pin a managed run and its private discovery file; authenticate session/workspace/process identity before adopting replacement; share recovery budget and reset diagnostics                                  | A subsequent command reaches the new app after PID/port/token rotation; interrupted operations dispatch once; foreign replacement is refused                            |
| B15 | P1 / source-confirmed | Launcher reuse/status/stop require the initial app PID even when the same tauri-dev supervisor legitimately replaces its child                           | Inherit a stable run identity, publish app incarnation in discovery and authenticated health, and reconcile the child PID without relaxing ownership                                                        | A new child of the same managed run is accepted; other run/workspace/instance metadata is rejected; shutdown uses the validated endpoint                                |
| B16 | P0 / source-confirmed | Normal full reloads leave renderer generation unchanged; pending evaluations lose their result and generation-only refs can alias another document       | Add native document epoch/loading state, interrupt pending evaluation on document replacement, cancel cooperative waits on departure, and scope refs by document identity                                   | Ordinary reload fails pending work promptly without a crash counter increment; load readiness is awaited; reused numeric ref suffix cannot click in another incarnation |

The first batch edits B01–B05; subsequent authorized bug-fix continuations add B06–B16 and their regression cases. All remain unverified. The helper remains API version 3 with revision 4, adds `diagnosticDocumentIds`, `locatorCompositionVersion: 2`, `locatorCollectionQueries`, `dispatchEventInit`, `locatorActionControl: 1` and `documentScopedRefs`, and uses shared automation core version 3. The revision guard prevents repeated installation in the same realm. Scoped queries, corrected event initialization and controlled mutations refuse an old helper before mutation. Collection reads detect missing support without performing a side effect; only provably complete small legacy counts fall back.

The B10 patch uses local monotonic active deadlines and a same-host wall-clock expiry for queued locator work. The cancellation registry is bounded at 1,000 entries, expires completed attempts at their action deadline and retains an overtaking cancellation tombstone for at most 120 seconds. Capacity exhaustion fails before dispatch. The native async-result registry retains at most 100 entries; cleanup marks controls cancelled, signals frame waits and prevents late result resurrection. It does not implement the durable action/session envelope proposed in section 6. `dispatched` conservatively means entry into the mutation function, including possible partial event sequences. Cancellation cannot undo completed events, forcibly terminate arbitrary evaluate code, or run on a blocked renderer thread.

For B13, callers specify `click({ waitForURL: /\/settings$/, timeout: 20_000 })` when delayed navigation is expected. A string matches the entire URL; partial matching uses RegExp. Glob syntax is unsupported. This removes the misleading substring behavior without claiming automatic inference of navigation scheduled at an arbitrary future time. Immediate navigation metadata still handles already-observed changes.

B14–B16 extend the existing launcher, CLI discovery writer, native lifecycle tracker and page-load hook. A random managed-run ID plus canonical workspace is inherited by rebuilt child processes; each process has a fresh appInstanceId and actual PID. Both discovery and authenticated health must agree before adoption. The ordinary CLI discovery file remains available; managed clients pin a second per-run discovery file, so unrelated Cognia launches cannot retarget them. Endpoint/session files are atomically replaced; Unix endpoint files are owner-only. Existing legacy runs keep their exact-PID guard and require one controlled relaunch for managed recovery. No launch/stop/restart/build command was invoked while writing this patch; an already-running watcher may independently react to source edits.

Recovery is for subsequent commands or explicit reconnect/waitForRenderer calls, never automatic replay of the interrupted command. It resets local diagnostic cursors on app replacement and waits for page readiness within the caller budget. Normal reloads advance documentEpoch independently of renderer crash generation; documentLoading ends at the native Finished event. Snapshot refs contain document identity, and pagehide cancels cooperative locator waits. Back/forward cache restoration creates a new incarnation and clears refs. Unsaved UI state, arbitrary evaluate termination and page-only evidence persistence are not supplied by this repair. Launcher --no-watch is an explicit stable-native-run option; frontend reload policy remains separate. This is a limited ownership/recovery foundation, not completion of C02/C03/C05.

The selected files are the existing client/helper/core and their co-located tests; no platform backend is introduced in this batch. The shared core also feeds the embedded browser overlay, so that consumer belongs in the later approved regression scope.

### 3.2 Synthetic input and missing engine observability require new capabilities

| ID  | Priority                 | Missing underlying capability                             | Why a bug patch is insufficient                                                                                                              | Delivery boundary                                                                                  |
| --- | ------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C01 | P1                       | Engine/OS input with browser default actions              | `element.click`, `KeyboardEvent` and `WheelEvent` cannot guarantee pointer sequences, text editing, focus navigation, CSS hover or scrolling | Windows CDP; macOS OS input; Linux X11 input; separately gated Wayland portal                      |
| C02 | P0–P1                    | Document-start capture plus host-owned evidence           | Page-load callbacks and in-page buffers cannot preserve an acknowledged record after a renderer dies                                         | Feature-gated bootstrap plugin, bounded producer channel and existing native spool                 |
| C03 | P1                       | Correlated action timeline and offline failure bundle     | Separate screenshot/log calls do not reconstruct which action caused which state change                                                      | Action envelope, source watermarks, typed attachments, offline timeline reader                     |
| C04 | P1 Windows; P2 elsewhere | Network lifecycle/details, routing and streaming evidence | Current fetch/XHR patches observe one realm, have summary fields, and consider fetch complete at response headers                            | CDP engine collector; WebKitGTK resource signals; explicit renderer/native/sidecar instrumentation |
| C05 | P1                       | Process/window ownership and native surfaces              | `TauriPage.close()` currently shuts down the app; JS dialogs are not system dialogs                                                          | DebugSession/Window/Page ownership, explicit app shutdown, native UI adapter or declared mock mode |
| C06 | P1                       | Source debugger and runtime profiling                     | DOM evaluate does not provide pause/step, stacks, locals, heap or CPU sampling                                                               | Renderer inspector; Rust LLDB/DAP; owned Node sidecar inspector                                    |
| C07 | P1 viewport; P2 advanced | Surface-defined screenshots/video                         | Desktop region capture can include occluders and currently repositions an off-screen window                                                  | WebView content capture versus window capture; explicit crop/full-page/video capabilities          |
| C08 | P0–P1                    | Real-WebView conformance lanes                            | Mock transport/jsdom cannot prove input defaults, native lifecycle or screenshot semantics                                                   | Shared behavior corpus with explicit platform/backend/permission requirements                      |

Input probes observed an untrusted click with no down/up sequence, unchanged text after Backspace, unchanged focus after Tab and no scroll after wheel dispatch. These are **C01 limitations**, not a request to implement a handwritten browser editing engine. `trustedEvents: false` remains accurate until a stronger backend passes its release gate.

The earlier stream probe kept a response body open while `pendingRequests` was already zero. Network-idle compatibility must state its observation scope; a separate application/stream completion assertion is required. Neither a general network-idle heuristic nor a fetch wrapper should be presented as proof that an AI turn has completed.

### 3.3 Additional source concerns need reproduction before being called fixed

| Candidate | Source concern                                                                              | Owning verification before implementation                                        |
| --------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| V01       | Per-evaluation 10 s cap, 15 s HTTP timeout and caller timeout are not one deadline          | Delayed/hung operation, cancellation and post-timeout side-effect fault cases    |
| V02       | Collection queries truncate to 500 nodes; `count` consumes the returned collection          | A fixture with 501+ matches must establish count/pagination semantics            |
| V03       | `dispatchEvent` constructs a CustomEvent and places supplied initialization inside `detail` | Event-class and initialization corpus against the documented supported subset    |
| V04       | Delayed navigation may occur after the action's immediate URL comparison                    | Delayed SPA navigation, document replacement, navigation failure and popup tests |

V02 and V03 were promoted to source-confirmed B06 and B07; V01 and V04 were subsequently promoted to B10 and B13. Their new regression cases have not been executed. None of these entries is a verified repair until its owning gate is approved and passes. Popup ownership, arbitrary-code termination and native input cancellation remain capability work, rather than implied results of these locator patches.

## 4. One control plane coordinates distinct execution and evidence paths

Keep discovery, authentication, session ownership and artifact control in the existing Rust bridge. Select an input backend explicitly; do not build a second application browser inside the debugger.

```text
Agent / Node client
        |
        | authenticated loopback control; session + window identity
        v
Existing agent-debug Rust bridge
        |---- DOM helper: locators, inspection, synthetic actions
        |---- WebView2 adapter: engine input / CDP diagnostics [Windows]
        |---- cognia-automation adapter: owned-window OS input [platform gated]
        |---- renderer inspector / Rust debugger / sidecar inspector
        |
        v
Existing observability writer -> privacy gate -> bounded local spool
        |
        v
Session timeline + diagnostic package / optional native Playwright trace
```

The authenticated bridge is the control boundary; the host spool is the evidence authority. A renderer event remains untrusted application data, even when it comes from a selected debugging window.

### 4.1 Extend existing owners instead of duplicating infrastructure

| Owner                     | Existing module                                                                                                             | Proposed extension and reachability                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Desktop debug maintainer  | `scripts/tauri/agent-debug.mjs`, client `.mjs` and `.d.mts`                                                                 | Capability negotiation, session ownership and explicit backend selection; preserve CLI discovery/token handling     |
| Native debug maintainer   | `src-tauri/src/agent_debug.rs`, `src-tauri/src/lib.rs`                                                                      | Register the bootstrap/plugin before any debug WebView is created; keep routes behind `agent-debug`                 |
| DOM automation maintainer | `lib/browser/automation-core.injected.js`, `src-tauri/src/agent_debug/injected.js`                                          | Preserve semantic query/action owner; extend only the documented subset                                             |
| Desktop input maintainer  | `crates/cognia-automation/src/automation/backend.rs`, `platform/{uia,ax,atspi}`, `shared/desktop_space.rs`                  | Reuse worker threading, key mapping and coordinate transforms; add a debug-session ownership adapter                |
| Observability maintainer  | `crates/cognia-observability/src/{event,writer,privacy,spool,diagnostic_package,trace_context}.rs`, `packages/logging/src/` | Reuse event/privacy/spool/package contracts; introduce debug-specific payload metadata and attachment indexes only  |
| Platform test maintainer  | `tests/e2e/helpers/tauri-cdp-launch.ts`, `tests/e2e/tauri/fixtures.ts`, `.github/workflows/test.yml`                        | Reuse Windows launch/attachment; introduce separately named real bridge/native lanes without replacing existing E2E |

`src-tauri/src/browser/cdp.rs` deliberately implements a limited eval facade for the embedded browser. It is not a general CDP transport and must not be reused as if it implements Network/Debugger/Input domains. Existing Chromium browser engines are also different processes from the Tauri application renderer.

A new module is justified only for a distinct owner absent today: platform debug adapters, session coordination, or an offline timeline reader. The plan does not create a new logging stack, credential store, renderer browser or automation backend hierarchy.

## 5. Platform paths have explicit guarantees and release gates

The table describes **target capability after its phase passes**, not today's support. OS input is operationally different from engine input and does not promise every user-activation/IME behavior solely because `isTrusted` is observed.

| Platform                 | Primary implementation path                                                                                                  | Diagnostics/debugger                                                                                                       | Constraints and gate                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows / WebView2       | Reuse owned-process CDP launch; connect using the resolved Playwright version; map each Tauri label to a verified CDP target | CDP Runtime/Network/Debugger/Profiler where runtime-supported; LLDB or a suitable Rust DAP adapter; sidecar Node inspector | Interactive session; target identity proof; default context is shared; each advanced feature must pass a WebView2-specific test                                      |
| macOS / WKWebView        | DOM semantic resolution plus `cognia-automation` point/key/scroll input under an exclusive owned-window lease                | Public `WKWebView.isInspectable` / Safari Web Inspector; Rust CodeLLDB; owned Node inspector; native spool                 | Accessibility permission, focus, screen topology; public WebKit inspection is not a stable Playwright/CDP endpoint; TCC denial is an explicit result                 |
| Linux / WebKitGTK on X11 | DOM semantic resolution plus existing Enigo input in a dedicated display/session                                             | WebKitGTK inspector and resource/lifecycle signals; LLDB/GDB through a chosen DAP adapter; Node inspector                  | Actual runtime/display dependencies recorded; app-window ownership and foreground verification; no assumption that `atspi` module supplies a full accessibility tree |
| Linux / Wayland          | C01 remains unavailable until a portal adapter passes the gate; add XDG RemoteDesktop session and negotiated input transport | Same WebKitGTK application/inspector paths; portal/PipeWire for permitted desktop capture when needed                      | User-mediated portal permission, compositor/backend variance, EIS versus Notify-method negotiation; `xdotool` presence alone is not proof of working input           |

### 5.1 Windows reuses real Playwright without claiming full protocol fidelity

Extend the current launcher to choose an isolated profile and an available debug port for the tracked process. Verify PID/session ownership before attachment, then discover application windows by a per-launch challenge/identity record, not by `pages()[0]` or a URL match alone. The session registry maps Tauri label + webview incarnation to target ID and invalidates the map on close/replacement.

Expose a genuinely native Playwright Page through an explicitly Windows-specific adapter rather than claiming `TauriPage` is a `Page`. Reuse Playwright locators, actionability, input, request/response events and assertions there. Native logs and Tauri command evidence remain available through the bridge.

Playwright documents CDP attachment as lower fidelity than its own protocol. The current Tauri fixture also reuses one existing context; fresh incognito contexts, recording, tracing, downloads and permissions must each be proven before being listed as available. `session.close()` owns teardown; closing an attached Page must not accidentally terminate all Tauri windows. See [Playwright CDP attachment](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).

Use public WebView2 APIs for in-process instrumentation where this avoids a network listener: document-created scripts, protocol calls/events and capture. The optional CDP listener needed by genuine Playwright is a separate opt-in exposure: the Cognia token does **not** authenticate that engine listener. It must be loopback-only, session-lifetime, excluded from ordinary builds and explicitly tested for ownership/cleanup. See [WebView2 API reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2?view=webview2-1.0.3967.48).

### 5.2 macOS uses public WebKit APIs and existing native input

Resolve the locator in the real WKWebView, obtain its frame-relative viewport rectangle and document identity, transform through iframe offsets/WebView bounds/zoom/scale using the existing desktop-space owner, and revalidate immediately before dispatch. Use point input, not AXPress, when the acceptance case requires pointer/default browser behavior.

Acquire the OS-input lease, activate the owned window when explicitly allowed, verify its foreground process and content bounds, then dispatch on the existing automation worker. A moved window, changed document, permission revocation or another foreground process causes `target_changed` / `focus_lost` before dispatch; it must not trigger a guessed coordinate or synthetic fallback. OS focus and check/dispatch are not perfectly atomic: retain this limitation in the guarantee and prove fail-fast cancellation under deliberate focus stealing.

Use the public WebKit snapshot API for content capture. Desktop/window capture is separately consented and reports its surface/occlusion semantics. Public inspectability enables Safari inspection; an automated WebKit inspector transport is a P3 feasibility track, not a promised stable macOS CDP backend. See [WKWebView public inspection/capture APIs](https://developer.apple.com/documentation/webkit/wkwebview/) and [Tauri Rust debugging](https://v2.tauri.app/develop/debug/vscode/).

### 5.3 Linux separates X11 delivery from Wayland feasibility

On X11, reuse the existing native point/key/scroll implementation and verify actual foreground-window ownership. Do not infer full AT-SPI query support from the module name: the inspected backend reports `has_a11y_tree: false` and rejects unsupported element operations.

WebKitGTK native capture and resource/lifecycle signals supply engine information unavailable to fetch patching. They do not by themselves supply Chromium CDP or a general response-mocking implementation. Record the installed system WebKitGTK version and test its available APIs before constructing capabilities. See [WebKitGTK snapshots](https://www.webkitgtk.org/reference/webkit2gtk/stable/method.WebView.get_snapshot.html) and [resource loading signal](https://webkitgtk.org/reference/webkit2gtk/stable/signal.WebView.resource-load-started.html).

On Wayland, add a separately owned portal session: CreateSession → SelectDevices → Start → negotiated input transport → Closed. Permission denial/revocation closes the lease and cancels queued actions. Use the negotiated portal version to choose supported Notify methods or EIS; never mix incompatible modes. Portal permissions can cover more than one app, so the debug adapter must still enforce the selected-window boundary. See [XDG RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).

### 5.4 A standardized runner is an alternative, not proof of engine guarantees

Current Tauri documentation recommends `@wdio/tauri-service` with an embedded WebDriver server, including macOS; the older blanket claim that macOS has no Tauri WebDriver route is no longer correct. However, the inspected embedded provider uses `el.click()` and synthetic event dispatch in its executor. A runner migration can improve sessions/reporting but cannot automatically satisfy C01. Evaluate a native-driver route with the same conformance corpus before selecting it. See [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/) and [provider implementation](https://github.com/webdriverio/desktop-mobile/blob/main/packages/tauri-plugin-webdriver/src/platform/executor.rs).

Playwright's own WebKit is a separately built browser, not the system WKWebView. Browser-only WebKit tests remain useful for shared behavior but do not certify a Tauri native path. Electron automation is also experimental and does not automatically intercept OS dialogs. See [Playwright browsers](https://playwright.dev/docs/browsers) and [Electron support](https://playwright.dev/docs/api/class-electron).

## 6. Negotiate guarantees, identities and deadlines before any side effect

### 6.1 Capability negotiation is per session, window, backend and permission state

Retain the existing v3 surface during the compatibility period. The first batch's capability additions are additive; older numeric-cursor callers remain readable, while scoped locator requests require `locatorCompositionVersion: 2` before dispatch. Raw diagnostic readers obtain the navigation-safe behavior by passing the returned `documentId` with their next `after` value.

The larger session protocol is proposed as a separately negotiated v4 contract:

| Contract          | Required fields / behavior                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session           | `sessionId`, `launchId`, owner PID + start identity, checkout identity, protocol version, expiry and permitted operations                                            |
| Target            | `windowLabel`, host-owned `webviewIncarnation`, `rendererGeneration`, renderer `documentId`, optional frame identity; labels alone are insufficient after recreation |
| Capability entry  | `name`, `available`, `backend`, `guarantee`, `scope`, `reason`, runtime version and permission state; reevaluate on permission/process changes                       |
| Action            | `actionId`, target identity, required guarantees, operation/arguments, remaining budget, abort token and requested backend                                           |
| Result            | action/target identity, backend used, terminal outcome, dispatch state, error code and evidence watermarks; no positional tuple responses                            |
| Diagnostic cursor | Session + host source sequence, with source/document identity and explicit loss/reset markers; old document events remain readable if acknowledged by the host       |

Example guarantee names are `input.synthetic`, `input.engine`, `input.os`, `network.renderer-summary`, `network.engine`, `capture.webview-viewport`, `capture.window`, `debugger.renderer`, `debugger.host`. Methods may have different guarantees for different backends. Requirements are checked before execution; `force` never bypasses permissions, session ownership or backend availability.

For compatibility, the legacy client defaults to synthetic behavior and declares it. A v4 client must request a backend/guarantee explicitly for mutations. A missing requirement returns `capability_unavailable` with a reason; there is no silent downgrade from OS/engine to DOM input.

### 6.2 Action ordering and failure states prevent accidental replay

```text
requested -> validated -> queued -> dispatched -> completed
     |            |          |           |
     +---------- rejected    +-> cancelled before dispatch
                                        +-> failed with known outcome
                                        +-> outcome unknown / renderer replaced
```

The bridge owns each action's state. Native input uses one exclusive desktop-input lease per interactive desktop, with per-session admission; DOM mutations serialize per window, while read-only evidence access remains independent. A test runner attaches one writer session to an app profile. Read-only observers do not consume another reader's cursor.

Deduplicate by `(sessionId, actionId)` plus a validated argument hash. Repeating a completed request returns its recorded result; reusing an ID with different arguments is rejected. This is bounded duplicate suppression, not an exactly-once claim across a native crash. If a command might have dispatched before timeout/disconnect/crash, return `outcome_unknown`; never auto-replay a click, text insertion or native action.

Resolve missing/unstable targets repeatedly only before dispatch. A navigation or detached node invalidates the target identity. Renderer recovery allows subsequent actions after an explicit rebind, but cannot prove that an earlier action had no external effect.

Use a single monotonic client deadline and pass a bounded remaining duration, not an absolute cross-process monotonic timestamp. Bridge queueing, validation, dispatch and result waits consume that budget. Transport cancellation requests host cancellation, and host cancellation releases held modifiers/buttons in `finally`. After dispatch it does not imply rollback. Debugger-paused sessions use an explicit paused policy; they do not appear as an ordinary hung-renderer timeout.

Stable error codes include `unsupported_query_version`, `capability_unavailable`, `permission_denied`, `target_changed`, `focus_lost`, `deadline_exceeded`, `cancelled`, `outcome_unknown`, `renderer_restarted`, `evidence_incomplete` and `session_owner_mismatch`. Preserve existing v3 renderer error codes through adapters during migration.

### 6.3 Separate process, window and page lifetime

Proposed API owners are `DebugSession`, `DebugWindow` and its page handle. `session.shutdown()` terminates only its tracked owned app; `session.detach()` disconnects; `window.close()` closes that owned window; a renderer page handle has no implicit app-shutdown authority. Keep legacy `TauriPage.close()` behavior for v3 with explicit documentation, then remove its ambiguity only in v4.

Inventory windows and child WebViews separately, with native lifecycle events and stable host incarnation IDs. A newly created window is not ready until its bootstrap handshake answers; closing and recreating the same label invalidates old handles. Rust process exit produces a terminal host record where possible; the external launcher records an observed exit even if the app cannot.

## 7. Evidence survives navigation and states its own completeness

### 7.1 Install capture before application scripts, then acknowledge records in the host

Register an `agent-debug` Tauri plugin with the pinned version's `js_init_script` / all-frames option before any application WebView is created. The inspected Tauri 2.12.0 source provides these hooks. Apply explicit owned-window/origin/frame checks; Windows injection can also reach subframes, so script placement is not authorization. Keep page-load reinjection as recovery, not the document-start guarantee. See [Tauri initialization hooks](https://docs.rs/tauri/2.12.0/tauri/plugin/struct.Builder.html).

Send bounded batches to a debug-only native command whose invoking WebView identity is derived by the host. Register command/ACL permissions only for the selected local debug surfaces; remote pages and unknown frame sources must not gain debug-control privileges. Validate payload schemas, byte limits, session identity and sequence numbers before acknowledgment. Renderer script content cannot choose another window's ownership fields.

The renderer retains unacknowledged batches for bounded retry; host acknowledgment is issued after privacy filtering and durable enqueue in the existing spool. Deduplicate source sequence within the producer incarnation. On navigation/crash, retain acknowledged evidence and record the last acknowledged watermark. Unacknowledged records may be lost: the report must state that boundary. Do not claim arbitrary JS hangs permit a final renderer flush.

Use `ObservabilityEventV1` log/span/lifecycle/metric variants with namespaced debug metadata. Reuse existing immutable trace context; do not add a mutable global action context that mixes concurrent async tasks. Native/sidecar operations carry explicit validated context where their contract supports it. Otherwise annotate temporal association as such rather than inventing a causal parent.

### 7.2 Network evidence has separate sources and stream states

Normalize network records as request-start → headers → optional body/chunks → completed/failed/cancelled, carrying request ID, redirects, source, target identity and redacted metadata. Record stream-open/closed/cancelled independently from headers. The synthetic backend advertises renderer summary capture until these states are actually observed; do not consume/tee arbitrary production streams merely to force completion detection without backpressure tests.

Windows uses engine network events for resources and transport lifecycle, plus public request/response/interception APIs where proven. Linux uses available native WebKitGTK signals and explicit application sources. macOS public WebKit APIs do not establish a universal transparent response interceptor; application-owned Rust/sidecar HTTP clients and renderer instrumentation cover their own traffic, while Web Inspector remains the interactive engine diagnostic route.

Engine traffic does not cover Rust/Node network activity automatically. Add spans at selected owned native HTTP/sidecar boundaries and publish `capturedSources` / `missingSources`. Mock routing is also backend-specific: v3 fetch fixtures remain fetch-only; engine routing, XHR, workers, WebSocket and HAR capabilities each have separate acceptance.

### 7.3 Capture surfaces and trace formats remain explicit

Expose WebView viewport capture separately from native window capture. Attach `surface`, logical bounds, pixel dimensions, scale factor, window/document identity, timestamp, backend and occlusion/foreground requirements. Off-screen or minimized capture either uses a supported engine/window API or returns a reason; it never moves the window without an explicit preparation option.

Full-page capture is a separate capability because scrolling/stitching can alter application state. Element capture derives its clip from the same target identity and coordinate transform as the capture backend. Video is separate from screenshot support and reports frame rate, gaps, dropped frames, sensitive areas and storage cap.

For a native Playwright trace, preserve its original format and label its engine/version. For other backends, provide a Cognia debug timeline containing ordered actions, state snapshots, console/network/native/sidecar records, attachment indexes, source-watermark/loss markers, build/runtime identity and source-map references. Do not generate a file named `trace.zip` that falsely claims compatibility with Playwright Trace Viewer. See [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer).

The offline reader must treat imported HTML/DOM/log data as untrusted: render sanitized/inert views, disable scripts and external resource fetches, validate manifest hashes and package paths, and show missing evidence prominently. Reuse the existing diagnostic package as the portable envelope; attach bounded timeline assets rather than creating another unsigned export format.

## 8. Debugging covers renderer, Rust and owned sidecars separately

| Target           | Delivery                                                                                                             | Acceptance                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Windows renderer | CDP Debugger/Profiler access or genuine Playwright attachment                                                        | Set breakpoint at a fixture source map location; inspect stack/locals; resume; collect a bounded profile                           |
| macOS renderer   | Public Safari inspection with per-WebView inspectability; automated transport remains gated                          | Open the selected real WKWebView, stop at fixture code and inspect stack; no programmatic-debugger claim without a transport proof |
| Linux renderer   | WebKitGTK WebInspector; native lifecycle/resource hooks                                                              | Inspect the real WebKitGTK renderer; prove version-specific profiling/network features independently                               |
| Rust host        | Source-controlled launch/attach recipes for CodeLLDB; Windows adapter verified against the chosen compiler/toolchain | Break inside a selected real Tauri command, inspect arguments and stack, continue without losing bridge ownership                  |
| Node sidecar     | Explicit debug launch of an owned child with a local inspector; PID/start identity mapping                           | Pause in a sidecar fixture, correlate its task with the invoking action, then resume/stop cleanly                                  |

Electron exposes renderer CDP and a separate V8 inspector for its Node main process. Rust is a different runtime and requires a native debugger; adding renderer `evaluate` or generic `invoke` is not equivalent. See [Electron debugger transport](https://www.electronjs.org/docs/latest/api/debugger) and [main-process debugging](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process).

Reuse current observability spans first. CrabNebula DevTools is an alternative for Tauri command/event timing and payload diagnosis; it is not a substitute for source breakpoints, nor a mandatory dependency for this plan. See [Tauri DevTools documentation](https://v2.tauri.app/develop/debug/crabnebula-devtools/).

## 9. Session privileges and evidence policy remain local and bounded

- Keep all new control routes, bootstrap commands, inspector activation and process attachments behind the explicit desktop `agent-debug` feature plus session authorization. A normal build must expose none of the new control/capture channels. Preserve the shared CLI bridge's existing production routes.
- Token possession authenticates the caller; session scopes authorize inspect, synthetic mutation, native input, body capture, debugger attach and app shutdown separately. Never place the bridge token or debugger credentials in renderer snapshots, URLs, bundles or telemetry.
- Native input is restricted to the selected app and its verified native dialogs. Permission/focus revocation cancels queued work. A user-operated emergency stop releases buttons/modifiers and ends the input lease. No automatic input is sent to another app to dismiss a permission prompt.
- Reuse the existing 30-minute local debug-capture session. Secret-key redaction always applies; content/body capture requires its separately active policy. Debug capture does not authorize remote upload or outbound model calls.
- Default persistent evidence is metadata only. DOM/text/screenshot/body artifacts require explicit content-capture scope. Scrub credential fields before DOM serialization; image capture uses redaction masks or a synthetic fixture profile when real content cannot be safely masked. Export requires artifact review under the existing diagnostic policy.
- Store artifacts under the canonical session root with restrictive permissions. Reject traversal, symlink escapes, unknown attachments and oversized frames at ingest/import. No business Dexie schema change or diagnostic-data sync/backup is introduced.
- Attach only owned PIDs with verified start identity, not a reused PID or any discoverable inspector port. Stop/detach must leave user-owned unrelated processes untouched.

These are implementation requirements for the added debug capabilities, not new confirmation prompts inserted into existing product flows. The current user-imposed test approval boundary remains separate.

## 10. Resource budgets are proposed gates, not measured performance claims

| Resource                  | Initial proposed budget                                                                                | Failure behavior                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Mutation concurrency      | 1 writer per window; 1 OS-input lease per interactive desktop; queue 32                                | Reject overload with a retry hint before dispatch                                         |
| Debug event batch         | 64 KiB / 100 records; flush at 100 ms or terminal event                                                | Bounded retry; no unbounded renderer buffer                                               |
| Native event spool        | Existing default: 50,000 events / 32 MiB per spool                                                     | Preserve protected events as designed; surface capacity rejection and loss                |
| Action timing             | Default 10 s, explicit maximum 120 s; attach/launch budgets separate                                   | One deadline; terminal dispatch state; no replay on ambiguous timeout                     |
| Content artifact          | 10 MiB image, 1 MiB DOM snapshot, 64 KiB body prefix per request                                       | Truncate with original-size/loss metadata or refuse; never report complete                |
| Session artifacts         | 250 MiB per session; 1 GiB total; proposed 7-day expiry; 30-minute content-capture scope               | Stop optional capture at cap; retain terminal/loss records; prune completed sessions only |
| Healthy renderer overhead | Proposed p95 event-ingest acknowledgment <250 ms; action instrumentation overhead <10% on fixed corpus | Compare capture on/off; disable optional content/video if exceeded                        |

The last two thresholds need measurement on supported machines; they are not present baseline observations. A native or renderer crash can lose the last unacknowledged batch. Disk-full and protected-event rejection produce `evidence_incomplete`, never a claim of a lossless recording.

Metrics are local by default: action duration/outcome by backend/operation/platform; queue depth; permission/focus failures; source acknowledgment lag; dropped/rejected records; screenshot failures and artifact bytes. IDs, URLs, selectors, user content and file paths are not metric labels. Record IDs only in scoped diagnostic records.

Operator actions: on any ownership/focus error, release input and reselect; on acknowledgment lag >1 s for three observations, mark capture degraded; on protected-event rejection or disk-full, stop optional capture and export the retained evidence; on repeated renderer timeout, collect host/process evidence before any separately authorized restart.

## 11. Deliver in independently reversible phases

| Phase / owner                                    | Scope and dependencies                                                                                         | Exit acceptance                                                                                                                         | Abort / rollback                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| M0 / DOM automation and native debug maintainers | B01–B16 and query/event/action-control capability refusal; current authorized edits                            | Approved focused Node/jsdom/Rust regressions pass; required real-WebView cases remain explicitly pending                                | Revert only selected patch files; v3 numeric cursor compatibility stays intact; no data migration |
| M1 / native debug maintainer                     | C02/C03 baseline, session identities, feature-gated bootstrap and host spool; depends on M0                    | Earliest fixture error captured; acknowledged records survive navigation/renderer death; incomplete-tail marker and offline export work | Disable capture plugin/flag; retain readable local V1 spool and packages                          |
| M2 / Windows maintainer                          | C01/C04/C06 via owned WebView2/CDP; M1 identities/evidence                                                     | Genuine pointer/key defaults, multiwindow mapping, network bodies under policy, debugger/trace capability matrix                        | Disable CDP mode and remove its listener/profile; retain synthetic mode with explicit guarantees  |
| M3 / Apple maintainer                            | C01/C07 macOS input/content capture and inspector recipes; M1 + existing automation owner                      | Permission/focus/topology corpus, WKWebView default behavior, no unintended input, viewport capture and host/sidecar breakpoints        | Release native lease and disable native mode; retain inspect/synthetic capabilities               |
| M4 / Linux maintainer                            | X11 native input, WebKitGTK capture/resource/lifecycle paths; M1                                               | X11 real-shell corpus and runtime-version evidence; no full-AT-SPI claim                                                                | Disable native adapter; retain supported DOM evidence                                             |
| M5 / Linux maintainer                            | Wayland portal transport and GNOME/KDE acceptance; M4 + portal feasibility                                     | Consent/revocation/coordinate corpus on both supported compositor families                                                              | Close portal session; mark native input unavailable, without silent X11/synthetic downgrade       |
| M6 / testing maintainer                          | CI matrix, offline timeline completeness and remaining advanced C04/C06/C07 paths; follows each platform phase | Every advertised guarantee has owning tests and retained evidence; unresolved platform capabilities remain unavailable                  | Disable only failing advanced capability; never make its required tests silently skip             |

M3 and M4 may proceed independently after M1. This is a dependency plan, not authorization to launch parallel agents or to start implementation beyond M0.

Programmatic macOS WebKit transport, full cross-origin-frame automation outside a proven engine path, IME composition certification, compositor-independent unattended Wayland input, full-page stitching and continuous video are explicit P2/P3 work. They are not prerequisites for declaring M0 fixed, but are prerequisites for claiming their respective capability. If full uniform Playwright debugger parity on every OS is mandatory, M0–M6 alone must not be described as satisfying it; Q4 defines the additional feasibility/runtime decision.

## 12. Acceptance verifies observed behavior, not method names

The user must approve verification before any command below is executed. Writing a regression case does not satisfy its acceptance. Broad coverage collection is opt-in and is not requested.

| Gate           | Required cases                                                                                                                                                          | Owning lane / pass standard                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A01 / B01      | Independent console/network readers; navigation A:3 → B:1; bounded retention; escaped/absent document ID; reinjection                                                   | Node + injected jsdom + native script-construction tests; no skipped/reset event without a marker                                                                              |
| A02 / B02      | Filter before/after nth; negative/repeated nth; nested descendants; and/or; has/hasNot with indexed inner locator; unsupported helper                                   | Client serialization plus actual helper resolution; wrong-target action count is zero                                                                                          |
| A03 / B03      | Open/nested shadow roots; overlay inside/outside root; actual click once; unsupported hit-test API                                                                      | Shared core + injected tests, then real WKWebView/WebView2/WebKitGTK; no force bypass in normal action                                                                         |
| A04 / B04      | Frame textarea/input/select; realm-local events; hidden parent; fill/type/select/upload where supported                                                                 | Unit fixtures plus real same-origin frame path; cross-origin returns an honest capability result                                                                               |
| A05 / B05      | Number/search roles; descendant image alt; hidden decoration; text/label baseline                                                                                       | Shared-core/semantic locator corpus; no claim of full ARIA conformance                                                                                                         |
| A06 / C01      | Pointer down/up/click order; CSS hover; Backspace/Tab/selection; modifiers; wheel actual scroll; React Flow drag; focus theft; moved/mixed-DPI windows                  | Windows engine, macOS OS input, Linux X11 and approved Wayland lane separately; each side effect is observed exactly as specified                                              |
| A07 / C02–C03  | Inline startup error; reload; window recreation; renderer crash/hang; host kill; disk-full; two readers                                                                 | Acknowledged watermarks survive; no cursor alias across documents; unavailable tail/source shown; partial package readable offline                                             |
| A08 / C04      | fetch/XHR/resource/redirect/error/abort; open stream; WS/worker where claimed; native and Node HTTP                                                                     | Every advertised source/lifecycle state captured; headers alone do not assert stream completion; missing-source flags match reality                                            |
| A09 / C05      | New/closed/recreated windows; selected native file dialog; mocked dialog clearly labeled; detach versus shutdown                                                        | No unrelated window/process is closed; selected app ownership is proven on each transition                                                                                     |
| A10 / C06      | Renderer source-map breakpoint; Rust command stack; owned sidecar breakpoint; pause/resume/profile                                                                      | Actual runtime evidence on each declared debugger path; unsupported automation remains unavailable                                                                             |
| A11 / C07      | Occluded/off-screen/minimized window; WebView viewport; scale/zoom; capture-mask policy; denied capture permission                                                      | Capture surface metadata matches pixels; no implicit window movement; unrelated desktop content is excluded or capture refused                                                 |
| A12 / security | Missing/expired token; foreign origin/window/PID; stale action ID; symlink/traversal import; secret fixtures; capture-scope expiry; CDP shutdown                        | No side effects after refusal; no secret fixture in persisted/exported evidence; optional listener closed; normal build lacks new routes/commands                              |
| A13 / B06      | 601 matches; text above 500 characters; whitespace; separate innerText; nth(600); legacy exact-cap ambiguity                                                            | Client and actual helper regressions; exact complete result or explicit size/capability refusal; state summaries never silently truncate                                       |
| A14 / B07      | MouseEvent/KeyboardEvent in a same-origin iframe; bubbles=false; custom detail; missing constructor and old helper                                                      | Correct fields/prototype and no unexpected bubble/dispatch; unsupported behavior fails before a side effect; trustedEvents remains false                                       |
| A15 / B08      | Target removes itself during scroll; force=true; normal retry on replacement                                                                                            | Zero actions on detached target; retryability limited to before dispatch                                                                                                       |
| A16 / B09      | Renderer replacement after dispatch; generic retryable error; missing dispatch phase; navigation timeout after click                                                    | One mutation per invocation; unknown outcomes never auto-replay; renderer recovery does not certify absence of persisted effects                                               |
| A17 / B10      | Abort/expiry during either stability frame; native cleanup; overtaking cancellation; duplicate ID; retry and navigation budgets                                         | Zero late clicks; queued work expires; pending frames/timers released; no result resurrection; one bounded client/native deadline; arbitrary evaluate interruption not claimed |
| A18 / B11      | Destination ambiguity/hidden/detached/replaced/retargeted; filters/last; legacy target index                                                                            | No dragstart before valid endpoint resolution; final identity fence blocks stale target; old explicit index is preserved                                                       |
| A19 / B12      | Multiple matches for isVisible/isHidden and attached/detached/visible/hidden waits; zero matches                                                                        | Typed strictness failure for ambiguity; expected zero-match visibility/hidden/detached behavior remains                                                                        |
| A20 / B13      | Expected delayed SPA/document URL; exact URL versus substring; cancelled wait; failed readiness; action already completed                                               | Action dispatches once, URL/readiness consume the remaining budget, cancellation reaches the transport, no false substring match                                               |
| A21 / B14      | PID/port/token rotation; connection loss during mutation; unavailable/loading replacement; abort/deadline; concurrent old response; scoped window                       | Same managed run reconnects, old diagnostic cursors reset, no interrupted mutation replay, no late operation submission, pending old-instance responses remain explicit        |
| A22 / B15      | Stable run/new child PID; different run/workspace/instance; pinned shutdown; atomically replaced discovery; legacy runs; no-watch parsing                               | Reconcile only matching discovery/authenticated identity; refuse foreign ownership; endpoint remains complete and private; normal CLI discovery remains available              |
| A23 / B16      | Ordinary reload during pending native callback/poll; another window reload; Started/Finished wiring; pagehide/frame wait; BFCache restore; identical numeric ref suffix | Native epoch changes without a crash increment; prompt document-replaced outcome; wait for Finished; zero late/stale-ref actions; selected-window isolation                    |

For native-input publication, run the deterministic corpus 20 consecutive times on each declared platform/backend with zero wrong-target actions, duplicate mutations or unreported evidence loss. Timing thresholds are assessed separately against the budgets above. An unavailable required runner/permission is a blocked platform gate, not a passing skipped test.

### 12.1 Proposed first verification request

After explicit user confirmation, start with these existing commands:

```bash
rtk pnpm tauri:debug:agent:test
rtk pnpm exec jest lib/browser/automation-core.injected.test.ts --runInBand
rtk cargo test -p cognia-next --features agent-debug agent_debug::tests --lib
rtk cargo test -p cognia-next --features agent-debug webview_watchdog::tests --lib
rtk cargo test -p cognia-next --features agent-debug cli_bridge::tests --lib
```

The Rust command requires the existing Tauri compile prerequisites/static assets; if they are unavailable, report the prerequisite and obtain approval before building them. Do not repair unrelated workspace changes to make this command pass. The current package command covers the Node/client and injected-helper suites; the separate shared-core file must be included explicitly.

Type/lint/format checks are a second explicitly requested scope under the current user instruction. Live shell validation is a third scope, with platform, target session, capture policy, possible focus changes and teardown stated before execution. No browser-only result may be labeled a real-shell pass.

M1–M6 require new owning scripts/CI entries at implementation time; no command names for those future lanes are represented as existing today. New/edited governed source ships its co-located tests. Product UI introduced later must follow split en/zh-CN i18n and static-export rules; the current patch adds no UI or translations.

## 13. Compatibility, migration and alternatives are explicit

| Producer / consumer                 | Compatibility behavior                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patched helper / older v3 client    | Existing methods and numeric reads remain accepted; extra fields/capabilities are additive                                                               |
| Patched client / older helper       | Simple queries retain their wire shape; scoped queries refuse before action; older diagnostics cannot acquire new cross-document guarantees              |
| Patched helper reinjection          | Revision guard prevents stacking wrappers; legacy buffered entries are assigned IDs in the new document's sequence                                       |
| Future v4 / v3                      | Separate handshake/adapter; never silently change legacy app-close or input behavior; retain v3 through two shipped minor releases before removal review |
| Future timeline / existing packages | Use existing V1 events/package envelope; debug attachment/index version is explicit; no business-state backfill                                          |

Do not rewrite old numeric cursor history or fabricate missing startup data. On rollback, keep already captured V1 evidence readable and disable optional capture/input backends. The entire application must remain usable without the debugger; teardown ends subscriptions, worker requests, inspectors and held input without detached tasks keeping tests alive.

| Decision                 | Recommendation                                                               | Alternative and consequence                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep current bridge      | Extend its existing identity/auth/client/helper owners                       | Replacing it with a new general automation product increases migration and loses native ownership without guaranteeing input fidelity        |
| Windows engine path      | Reuse genuine Playwright over owned WebView2 CDP, with capability tests      | Handwritten CDP/locator emulation duplicates Playwright; optional in-process diagnostics remain useful but are not a complete Page transport |
| macOS/Linux native input | Reuse `cognia-automation` with debug-session restrictions                    | Adding another Enigo/CGEvent/SendInput stack duplicates permissions, threading and coordinates                                               |
| Evidence                 | Reuse ADR-0102 writer/privacy/spool/package                                  | A second raw log/zip store diverges in secret redaction, retention and corruption handling                                                   |
| Cross-platform runner    | Keep the existing workflow initially; evaluate WDIO only by guarantee/corpus | Standard WebDriver naming alone cannot prove trusted input or debugger coverage                                                              |
| Universal engine         | Do not replace the app renderer for debugging                                | A Chromium-only replacement changes runtime behavior and must be a separate product/runtime decision                                         |

## 14. Review closes decisions before new backend implementation

| Decision | Options                                                                                                                        | Recommendation / consequence                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1       | A: capability-specific alignment; B: uniform Playwright parity on every platform                                               | A. B requires an additional WebKit transport/runtime feasibility decision and cannot be promised by DOM patches                                              |
| Q2       | A: existing native input plus owned-window lease; B: require a native WebDriver provider everywhere                            | A for macOS/X11; evaluate B with the same default-action/security corpus before substitution                                                                 |
| Q3       | A: metadata default + 30-minute local content scope + existing package; B: always-on raw DOM/body/video                        | A, consistent with ADR-0102; B conflicts with the inspected privacy contract                                                                                 |
| Q4       | A: public/manual WebKit inspector now, automated transport as gated P3; B: make automated macOS debugger a release requirement | A for the initial release. If B is selected, the release remains blocked until public/maintained transport evidence or a separate runtime choice is approved |

| Review item                                                      | Owner role                    | Proposed review date | State                                                  |
| ---------------------------------------------------------------- | ----------------------------- | -------------------- | ------------------------------------------------------ |
| Confirm M0 implementation scope and test hold                    | Requesting user               | 2026-10-19           | Confirmed in this chat; tests still await confirmation |
| Review protocol/guarantees and duplicate-side-effect handling    | Desktop automation maintainer | 2026-10-21           | Proposed; not an assigned commitment                   |
| Review platform feasibility and permission gates                 | Native platform maintainer    | 2026-10-21           | Proposed; not an assigned commitment                   |
| Review spool/privacy/package reuse and capacity budgets          | Observability maintainer      | 2026-10-21           | Proposed; not an assigned commitment                   |
| Review real-WebView CI runner availability and acceptance matrix | Testing maintainer            | 2026-10-21           | Proposed; not an assigned commitment                   |

The review dates are proposal targets, not scheduled work or a promised delivery date. There are no ownerless implementation TODOs: new backend work is assigned by role in M1–M6 and remains gated by Q1–Q4 and platform evidence.

## Sources and implementation evidence

Repository paths below are the owning sources inspected for this proposal. They may contain the unverified M0 changes by the time this document is reviewed.

- [Agent-debug Rust bridge](../../src-tauri/src/agent_debug.rs), [injected helper](../../src-tauri/src/agent_debug/injected.js), [bootstrap/lifecycle integration](../../src-tauri/src/lib.rs), [renderer watchdog](../../src-tauri/src/webview_watchdog.rs).
- [Node client](../../scripts/tauri/agent-debug-client.mjs), [declarations](../../scripts/tauri/agent-debug-client.d.mts), [launcher/CLI](../../scripts/tauri/agent-debug.mjs), [existing skill contract](../../.agents/skills/tauri-agent-debug/references/playwright-api.md).
- [Shared core](../../lib/browser/automation-core.injected.js), [embedded overlay consumer](../../lib/browser/overlay.injected.js), [limited browser CDP facade](../../src-tauri/src/browser/cdp.rs).
- [Automation backend](../../crates/cognia-automation/src/automation/backend.rs), [macOS](../../crates/cognia-automation/src/automation/platform/ax/mod.rs), [Windows input](../../crates/cognia-automation/src/automation/platform/uia/input.rs), [Linux](../../crates/cognia-automation/src/automation/platform/atspi/mod.rs), [coordinate owner](../../crates/cognia-automation/src/automation/platform/shared/desktop_space.rs).
- [Native privacy](../../crates/cognia-observability/src/privacy.rs), [writer](../../crates/cognia-observability/src/writer.rs), [spool](../../crates/cognia-observability/src/spool.rs), [package](../../crates/cognia-observability/src/diagnostic_package.rs), [trace context](../../crates/cognia-observability/src/trace_context.rs), [renderer privacy](../../packages/logging/src/privacy-manifest.ts).
- [Windows launch](../../tests/e2e/helpers/tauri-cdp-launch.ts), [existing fixture](../../tests/e2e/tauri/fixtures.ts), [CI](../../.github/workflows/test.yml), [scripts/dependencies](../../package.json), [Rust lockfile](../../Cargo.lock).
- [Playwright actionability](https://playwright.dev/docs/actionability) and [input](https://playwright.dev/docs/input) establish the comparison behavior. Platform API sources and their qualifications are linked beside the relevant proposed path above; no secondary comparison article is used as implementation authority.
