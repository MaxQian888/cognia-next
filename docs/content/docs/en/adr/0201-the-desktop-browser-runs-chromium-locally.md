---
title: "0201 — The desktop browser runs Chromium locally"
description: "Adds two desktop Chromium backends alongside the embedded webview. Cognia-managed local Chromium runs the workspace-runtime browser service on loopback. The user's Chrome connects through consent-gated remote debugging. Adds multi-tab browsing, downloads, Chrome extensions, cookie import from every major browser on every desktop OS, a Rust-only password vault with autofill, local files and dev-server discovery. Built-in and external agents share one session-aware browser tool surface."
---

# ADR 0201 — The desktop browser runs Chromium locally

**Status:** Accepted
**Amended by:** [ADR-0214](./0214-the-chat-dock-is-a-tabbed-browser-that-remembers-each-task) (localhost defaults to local Chromium; one shared local session whose pages belong to conversations)
**Date:** 2026-09-29
**Related:** [ADR-0055](./0055-agent-browser-loop) (agent browser loop), [ADR-0072](./0072-browser-action-recording), [ADR-0073](./0073-chromium-cookie-import) (cookie import, amended here), [ADR-0085](./0085-cloud-shared-browser) (workspace-runtime browser service, reused here), [ADR-0154](./0154-browser-companion) (unchanged: the companion extension still never drives a page), [ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked) (crate placement)

## Context

The desktop browser is one WKWebView / WebView2 / WebKitGTK child webview. It
cannot host Chrome extensions (WKWebView has no extension runtime), has no tabs,
no download handler, no native input, no dialog or file-chooser hook, and only a
two-method CDP shim. Cookie import is macOS + Chromium + one host only. There
is no password import. External agents can reach the embedded browser only
through the generic `plugin_tool_invoke`, which skips the per-character gate,
per-tool approval and session binding.

A full Chromium browser service already exists: `services/workspace-runtime`
(Node + `playwright-core`) implements pages, snapshots with opaque refs,
native actions, dialogs, uploads, quarantined downloads, screencast and
persistent profiles for the cloud (ADR-0085). The desktop already bundles a
verified Node runtime (`src-tauri/src/node_runtime.rs`).

OpenAI's desktop browser (2026) converged on the same product shape: separate
profile, multi-tab, downloads, sign-in/autofill/password management,
Chrome extensions, localhost and `file://`, and a second channel that attaches to
the user's own Chrome.

## Decision

### Four desktop backends behind one `BrowserEngine`

| Backend | Engine | Owns | Default for |
| --- | --- | --- | --- |
| `embedded` | platform webview (unchanged) | single page, injected JS | the lightweight preview: a page tab switched to it, and every page before Chromium is installed (localhost by default until ADR-0214) |
| `local-chromium` | workspace-runtime service on loopback, Chromium from Playwright's Chrome-for-Testing build | tabs, downloads, extensions, native input, dialogs, uploads, full snapshot parity with cloud | every page once installed, localhost included since ADR-0214; user choice |
| `user-chrome` | same service, `connectOverCDP` into the user's running Chrome/Edge/Brave | the user's real profile, logins and extensions | explicit user choice |
| `remote` | ADR-0085 cloud runtime (unchanged) | cloud / mobile / headless | non-desktop hosts |

`BrowserBackend` (TS) becomes `"embedded" | "local-chromium" | "user-chrome" | "remote" | "web-fallback"`.

### Local Chromium: the runtime, run by the desktop

- `services/workspace-runtime/src/local-main.mjs` is a second entrypoint that
  hosts **only** `RemoteChromiumService` (no `AgentSupervisor`), binds
  `127.0.0.1` on an ephemeral port, reads its 32+ byte secret from stdin (never
  argv/env), prints `{"type":"ready","address":…}` on stdout, and runs in
  **local mode**: `mode: "local"` enables `session.create` fields the cloud
  refuses (`kind`, `headless`, `extensionPaths`, `cdpEndpoint`,
  `downloadsDir`, `uploadRoots`, `allowFileUrls`).
- The new crate `crates/cognia-local-browser` (layer `domain`, tauri-free,
  `tauri-host` feature for command shells is not needed: shells live in
  `src-tauri/src/browser/local.rs`) owns: process supervision (bundled Node,
  restart with backoff, kill on app exit), the loopback HTTP client, the
  Chromium installer (runs the staged `playwright-core` CLI with
  `PLAYWRIGHT_BROWSERS_PATH=<app_data>/browser/chromium`), the extension store,
  and user-Chrome discovery.
- The renderer never sees the runtime URL or secret. Every call goes through
  `browser_local_rpc(op, payload)`, whose op allow-list excludes value-carrying
  ops (`browser.cookies.set`, `browser.credential.fill`); only Rust issues those.
- Frames: Rust polls `/v1/media/:session` and pushes the existing 24-byte framed
  JPEG through a Tauri `Channel<Vec<u8>>`, so `decodeRemoteBrowserFrame` and the
  remote canvas preview are reused unchanged.
- Events: Rust tails `/v1/events` and re-emits them as `browser-local://event`
  (`pages.changed`, `download.updated`, `dialog.opened`, `session.closed`).
- Profile: one persistent Cognia profile at `<app_data>/browser/profiles/default`
  (named profiles allowed), separate from Cognia's own webview data.
- Staging: `scripts/build/stage-browser-runtime.mjs` copies the runtime source,
  the shared injected overlay and `playwright-core` into
  `src-tauri/resources/browser-runtime/` in `predev`/`prebuild`.

### The user's own Chrome

Chrome 144+ lets a user enable remote debugging for their running browser at
`chrome://inspect/#remote-debugging`; Chrome then writes `DevToolsActivePort`
into the user-data directory and **asks the user to allow each new connection**.
`cognia-local-browser::user_chrome::discover()` reads that file for Chrome,
Chrome Beta/Canary, Edge, Brave (per-OS paths), and the runtime attaches with
`connectOverCDP`. Cognia never launches the user's browser with debugging flags,
never copies its profile, and never persists the endpoint. Agent tabs are
opened in a dedicated window. `finalize` closes tabs the agent created and
leaves the user's tabs untouched. If the file is missing the discovery result
carries `reason: "remote_debugging_disabled"` and the UI links the user to the
Chrome setting.

### Downloads

- Local/user Chromium: every download is tracked with progress
  (`download.updated` events: `in_progress → completed | cancelled | failed`),
  saved into the user's Downloads directory (configurable, "ask where to save"
  optional) with collision-safe names. Ops: `browser.download.cancel`,
  `browser.download.delete`, `browser.download.save` (copy to a chosen path).
  The cloud keeps ADR-0085 quarantine semantics.
- Embedded: `WebviewBuilder::on_download` routes downloads to the same
  Downloads directory and emits `browser://download` (`requested`, `finished`).
- Renderer: Dexie `browserDownloads` (history, no bytes), a Downloads panel
  (progress, cancel, open, reveal in folder, retry, remove from list, clear),
  a toolbar badge, and "attach to chat". `BrowserDownloadSummary` gains
  `url`, `mimeType`, `totalBytes`, `receivedBytes`, `startedAt`, `finishedAt`,
  `savedPath`, `error`, `backend`, and states `in_progress | completed |
  cancelled | failed | quarantined | saved | attached`.

### Chrome extensions (local Chromium)

- Store: `<app_data>/browser/extensions/<id>/` unpacked + `registry.json`
  (id, name, version, enabled, source `webstore|crx|unpacked`, installedAt,
  permissions, hostPermissions, icons, action popup and options paths).
- Install from the Chrome Web Store by id or URL (CRX download from the
  public update endpoint, CRX3 header verification of the declared id, zip
  extraction with path-traversal rejection), from a `.crx` file, or from an
  unpacked directory (copied, never referenced in place). Update checks the
  same endpoint. Enable/disable/remove.
- Launch: enabled extensions are passed as `--disable-extensions-except` /
  `--load-extension` and the service restarts live sessions on change
  (`browser.extensions.reload`). Headless-new Chromium runs MV3 service
  workers and content scripts; action popups and options pages open as tabs
  (`browser.extension.open`).
- The embedded backend and `user-chrome` do not load Cognia's extension set:
  the embedded webview cannot (typed `extensions_unsupported_backend`), and
  the user's Chrome already has its own.

### Cookie import (amends ADR-0073)

| Source | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Chrome, Edge, Brave, Chromium, Arc, Vivaldi, Opera | Keychain Safe Storage, v10 AES-128-CBC | DPAPI-unwrapped `os_crypt.encrypted_key`, v10/v11 AES-256-GCM; **v20 App-Bound rows are skipped and counted** (`app_bound_encryption`) | v10 (`peanuts`) and v11 (Secret Service via `secret-tool`) AES-128-CBC |
| Firefox (all profiles) | plaintext `cookies.sqlite` | same | same |
| Safari | `Cookies.binarycookies` (needs Full Disk Access; typed `full_disk_access_required`) | — | — |

Scope: one site (as before), a chosen set of registrable domains, or all
domains. `browser_cookie_domains` lists a profile's domains and counts without
decrypting. Sinks: embedded webview (macOS WKHTTPCookieStore as before;
Windows/Linux via Tauri `Webview::set_cookie`) and local Chromium
(`browser.cookies.set`, Rust→runtime only). Values stay in Rust exactly as in
ADR-0073.

### Password vault and autofill

- Import: the same Chromium browsers (`Login Data`, same key per platform, v20
  skipped and counted), Firefox (`logins.json` + `key4.db`, NSS PBES2 /
  3DES, no primary password; a set primary password returns
  `primary_password_set`), and CSV (Chrome/Edge/Brave, Safari, Firefox,
  1Password, Bitwarden, LastPass, generic `url,username,password`).
- Storage: each password is a `cognia-secrets` `secret_store` entry
  (`cognia.browser.passwords` / credential id); metadata (origin, realm,
  username, source, timestamps, note) is a second secret-store entry. Nothing
  is written to Dexie, logs or IPC except metadata.
- Reveal / copy / export require OS user presence
  (`cognia_secrets::user_presence::verify`: macOS LocalAuthentication,
  Windows Hello `UserConsentVerifier` with credential-prompt fallback, Linux
  polkit `pkcheck`); a failed or unavailable check refuses.
- Autofill: the pane detects login forms (`browser.forms.detect-login` /
  embedded overlay `__cogniaDetectLogin`), offers matching credentials by
  registrable domain, and Rust fills them (`browser.credential.fill` or an
  embedded eval) so the value never reaches the renderer. Save/update prompts
  after a form submit on local Chromium.
- Agents may call `browser_fill_credential`, which requires per-call approval,
  fills by credential id or the unique match, and returns only
  `{filled: true, username}`. Snapshots and logs keep redacting secret fields.

### Local content

- Local files: `browser_local_file_serve(path)` starts (once) a loopback static
  server in Rust bound to `127.0.0.1:<ephemeral>` that serves a chosen
  directory under a random 128-bit path prefix, so relative assets work and the
  embedded trust tier (`localhost`) applies. The address bar accepts absolute
  paths and `file://` URLs and routes them through it; local Chromium may also
  open `file://` directly (`allowFileUrls`).
- Dev servers: `browser_dev_servers_detect()` lists loopback TCP listeners
  (lsof / netstat), probes HTTP, and returns `{url, port, pid, process, title}`;
  the empty state shows them instead of three hard-coded ports.
- `resolveTrustTier` treats `127.0.0.0/8`, `::1`, `localhost` and
  `*.localhost` as trusted.

### Agent tool surface

New tools in `plugins/browser-tools`: `browser_open` (show the pane / choose a
backend), `browser_download` (list / save / cancel / attach), `browser_pdf`,
`browser_emulate`, `browser_cookies` (metadata list, clear; never values),
`browser_storage` (localStorage/sessionStorage, trusted tier or approval),
`browser_network_request` (headers + truncated body, auth headers redacted),
`browser_fill_credential`, `browser_extensions` (list, open popup/options),
`browser_tabs_finalize` (user-chrome). Fixes: navigate routes on the target
URL, grants are live (Dexie subscription), an authorized public URL falls back
to the best available desktop engine instead of throwing, embedded
`close_page` no longer navigates to `about:blank`, the embedded engine refuses
secret fields like the remote one, and `requiresApproval` reaches the sidecar
manifest.

### External agents

The External Bridge MCP server gains first-class `browser_*` tools that proxy
the same plugin tool implementations with: a new `browser:control` scope,
per-character-independent enablement in Settings → External Bridge, a bound
chat/browser session per MCP client, the per-tool approval flag honored, and
auto-opening of the browser pane (or a headless local-Chromium session when no
window is visible). `plugin_tool_invoke` refuses `cognia-browser-tools`
and points at the dedicated tools.

## Consequences

- Public-site automation, extensions, downloads and tabs work on the desktop
  without a cloud runtime; the embedded webview stays the zero-install default.
- The desktop ships ~2 MB more (runtime + playwright-core); Chromium
  (~170 MB) is downloaded only when the user installs it.
- Windows App-Bound (v20) data is never decrypted. Users on current Chrome for
  Windows import passwords via CSV or use `user-chrome` for logged-in sessions.
- Password values exist only in Rust memory, the encrypted secret store, the
  target page, and an explicit OS-authenticated reveal or export.

## Rejected alternatives

- A self-built MV3 extension with `chrome.debugger` to drive the user's Chrome:
  duplicates Chrome's own consent-gated remote debugging and would contradict
  ADR-0154's companion boundary.
- WebView2 extensions only: Windows-only, and requires isolating the main
  webview's environment.
- Rewriting a Rust CDP engine: the Playwright service already exists, is tested,
  and gives cloud/desktop snapshot parity.
- Storing passwords in Dexie (even encrypted in the renderer): renderer
  compromise would expose them.
