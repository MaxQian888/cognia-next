# Codex App CDP session bootstrap research (2026-08-11)

## Decision

**Yes, CDP can plausibly bootstrap an App-originated task, but it should be a local UI bootstrap adapter, not the shared runtime protocol.**

The strongest PoC is a hybrid:

1. launch the Codex App with its existing App Server relay and a loopback-only Electron remote-debugging port;
2. open the App's native `codex://new?prompt=...&browserUrl=...` deep link;
3. use CDP against the App renderer to verify the composer and Browser panel, select any required capability, and submit;
4. let the App-owned runtime create the thread/turn;
5. have the existing relay correlate a nonce in the prompt with `threadId`, then read and stream that thread to Cognia Web.

This keeps execution App-originated, which is the best candidate for retaining the App-owned Browser/IAB binding. CDP itself neither creates a canonical Codex session nor grants Browser capability; only a live Browser smoke test can prove that the UI-created task receives an `iab` backend.

```text
Cognia Web
  -> authenticated outbound local bridge
  -> native Codex deep link + narrow CDP UI actions
  -> Codex App renderer
  -> App-owned App Server creates thread/turn
  -> existing relay observes threadId and events
  -> Cognia Web reads/displays the same task
```

## What CDP can and cannot do

CDP is technically sufficient for renderer automation. Chromium's official protocol exposes target discovery/attachment, DOM inspection, JavaScript evaluation, and keyboard/mouse/touch dispatch. Electron officially supports `--remote-debugging-port=<port>`, which enables remote debugging over HTTP. Its target-list endpoint exposes a WebSocket debugger URL for each renderer target.[^cdp][^target][^dom][^runtime][^input][^electron-switches]

Therefore a local controller can discover the Codex App's main renderer, focus the new-task UI, type or validate a prompt, click capability controls, and submit. This is **UI automation**, not App Server control:

- CDP acts on `BrowserWindow`/renderer state; the App's own code subsequently calls its App Server.
- The relay remains the authoritative source for `threadId`, canonical turns, approvals, tool events, and completion.
- CDP does not expose a documented Codex `thread/start` or `turn/start` command.
- Native macOS dialogs, permission sheets, and other non-renderer surfaces are outside renderer CDP; they still require the user, Accessibility, or Computer Use.
- Private DOM structure is version-sensitive. The controller should prefer accessible names/text and assert visible state after every action rather than pinning generated CSS classes.

Electron also exposes an in-process `webContents.debugger` CDP transport, but an external Cognia bridge cannot use it without modifying or injecting code into the App main process. The external remote-debugging port is the less invasive experimental attachment point.[^electron-debugger]

## Local evidence from the installed App

Read-only inspection on 2026-08-11 found:

- `/Applications/ChatGPT.app/Contents/Info.plist` identifies the bundle as `com.openai.codex`, version `26.803.61601`.
- The running process is `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`; its renderer/service helpers come from `Codex Framework.framework/Versions/151.0.7922.76`, confirming a Chromium/Electron-style multi-process application.
- The live one-runtime chain was `ChatGPT -> relay-shim.mjs -> bundled codex app-server`.
- The current main App process had no listening TCP socket, and `~/Library/Application Support/Codex/DevToolsActivePort` was absent. A normal launch therefore did **not** expose CDP.
- The production bootstrap in `Contents/Resources/app.asar` contains `CODEX_ELECTRON_CHROMIUM_SWITCHES`, but explicitly accepts it only when the build flavor is `Dev`. That environment hook is not a path for the installed production build.
- The same packaged source parses `codex://new` and `codex://threads/new`. Query parameters include `prompt` and `browserUrl`. For a new task, `prompt` becomes `prefillPrompt` plus `focusComposerNonce`; `browserUrl` sends `toggle-browser-panel` with `open: true`, `source: "manual"`, and `initiator: "open_in_browser_bridge"`.

The last point materially improves the PoC: the packaged App route can prepare both the composer and the App's own Browser panel before CDP presses Send. It does **not** prove that the deep link auto-submits or that an IAB backend is registered; packaged code shows prefill/navigation and panel opening, not a completed turn.

## macOS launch constraints

The debug switch must be present on the primary App process at startup. Electron documents single-instance coordination through `app.requestSingleInstanceLock()`; arguments passed to a second launch are delivered according to application-specific handling and cannot be assumed to reconfigure Chromium in an already-running primary process.[^electron-single-instance]

Local `/usr/bin/open` supports `--args` for passing launch arguments and `--env` for adding launch environment variables. For this App, a controlled test should therefore:

1. drain and quit the current App cleanly;
2. verify the old primary and App Server have exited;
3. relaunch once with the existing relay environment plus `--remote-debugging-port=<dedicated-port>`;
4. verify the listener address with `lsof` and the target list through `/json/list`;
5. automatically roll back to a normal launch if CDP or relay health fails.

Direct Chromium arguments on this signed production build remain **untested** in this research pass. Electron documents the switch, but the Codex App may filter, ignore, or change support between versions. Another restart is required to establish that fact.

## Browser/IAB conclusion

CDP can cause the same visible actions as a user in the App renderer. That makes it more promising than a Web-originated raw `turn/start`, which the existing PoC showed could load the Browser skill but had no `iab` backend.

However, CDP and IAB are separate surfaces:

- CDP controls the Codex App renderer.
- IAB is an App-owned browser backend registered into an agent session.
- Opening the native Browser panel may trigger that registration, but this is an inference from packaged behavior, not a documented contract.

The acceptance test must create a fresh task through the App UI, explicitly open Browser, submit a nonce prompt, and then require all of the following:

1. the relay observes exactly one new App-owned `threadId` matching the nonce;
2. the App and Cognia read the same canonical turn;
3. inside that turn, `agent.browsers.list()` contains `iab`;
4. a real navigation succeeds and is visibly rendered in the App Browser panel;
5. approval requests remain handled by the App.

Without item 3 and 4, CDP has only automated task creation; it has not solved Browser capability sharing.

## Security boundary

A DevTools endpoint is a privileged control surface: CDP permits arbitrary renderer evaluation, DOM access, input injection, network inspection, and page control. Chrome's security team documents remote debugging being abused by infostealers to extract cookies; beginning with Chrome 136, Chrome ignores remote-debugging switches against its default data directory unless a non-default `--user-data-dir` is supplied. That Chrome-specific restriction is not evidence that Electron enforces the same rule, but it demonstrates the risk class.[^chrome-security]

Product constraints:

- never expose the CDP port to Cognia Web or the public network;
- verify the actual listener is loopback-only before attaching;
- keep CDP behind an authenticated, user-scoped local bridge;
- expose narrow commands such as `bootstrapTask`, `openBrowser`, and `submitComposer`, not raw CDP passthrough;
- use per-request nonces, short deadlines, single-flight task creation, and an allowlist of App targets;
- keep App Server, shell, filesystem, Computer Use, and plugin transports private to the host;
- disable CDP after bootstrap if a clean lifecycle can be implemented, otherwise require an explicit local opt-in for the entire debug-enabled App session.

Electron's security guidance also recommends context isolation, sandboxing, restricted navigation/window creation, and validating IPC senders. CDP does not replace those boundaries; it is an additional high-privilege local endpoint.[^electron-security]

## Recommendation

Proceed with one version-pinned PoC, but test the native deep link before building generic DOM automation:

```text
codex://new?prompt=<nonce-and-instruction>&browserUrl=<test-url>
```

Use CDP only to inspect the resulting renderer state, select any missing Browser affordance, and submit. Correlate the resulting task through the existing relay. If the turn receives `iab`, this becomes a viable bootstrap mechanism for an App-owned long-running bridge session. If it does not, further DOM automation will not fix the missing host binding; the next investigation must target the App's private Browser-session registration path.

This should remain an experimental fallback. The durable product boundary should be a narrow local bridge over stable App/runtime semantics, with CDP confined to the unavoidable “make the App originate the task” step.

## Primary sources

[^cdp]: [Chrome DevTools Protocol overview](https://chromedevtools.github.io/devtools-protocol/)

[^target]: [CDP Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/)

[^dom]: [CDP DOM domain](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)

[^runtime]: [CDP Runtime domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)

[^input]: [CDP Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)

[^electron-switches]: [Electron supported command-line switches](https://www.electronjs.org/docs/latest/api/command-line-switches)

[^electron-debugger]: [Electron `webContents.debugger`](https://www.electronjs.org/docs/latest/api/debugger)

[^electron-single-instance]: [Electron `app.requestSingleInstanceLock`](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)

[^chrome-security]: [Chrome: Changes to remote debugging switches to improve security](https://developer.chrome.com/blog/remote-debugging-port)

[^electron-security]: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)

## Local evidence commands

All commands were read-only. Paths are shown explicitly so the findings can be repeated after an App update.

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' '/Applications/ChatGPT.app/Contents/Info.plist'
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' '/Applications/ChatGPT.app/Contents/Info.plist'
ps -axo pid,ppid,command
lsof -nP -a -p <primary-app-pid> -iTCP -sTCP:LISTEN
test -e "$HOME/Library/Application Support/Codex/DevToolsActivePort"
strings '/Applications/ChatGPT.app/Contents/Resources/app.asar'
```
