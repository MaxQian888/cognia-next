# Remote desktop Phase 5: web consoles and RustDesk launch (ADR-0234)

Phases 2–3 gave every client one way to reach an external machine: a VNC
binding the Host bridges. Phase 5 adds the two ways the ADR keeps for
everything else:

- a **web console**, the user's own Guacamole or MeshCentral page;
- an **external app**, RustDesk, launched with `rustdesk://`.

Cognia brokers neither connection. It stores where the console or peer is,
admits who may open it, and audits the open. The provider authenticates the
user and enforces what they may do, so these bindings are always labelled
"permissions managed by the provider" and never offer a view-only mode or a
lease.

## Upstream facts (verified 2026-10-18)

- **Guacamole.** A connection page is `…/#/client/<identifier>`. Since 1.5
  the identifier is unpadded base64url of `id \0 c \0 dataSource`
  (`ClientIdentifier.js`); older releases used another encoding. The session
  is the web app's own auth token.
- **MeshCentral.** `?gotonode=<node id>` (or `gotodevicename=`) selects a
  device, and `viewmode=11` opens its desktop. `login` and `logintoken` carry
  login tokens in the URL. Framing is refused by default (`X-Frame-Options:
sameorigin`), which is why the ADR uses a top-level webview.
- **RustDesk.**
  - `urlLinkToCmdArgs` (`flutter/lib/common.dart`) accepts several link forms.
    `rustdesk://connection/new/<id>` is the one every client version accepts,
    and it keeps the ID's case because the ID is in the path, not the host.
  - `<id>@<server>` names a self-hosted server. `?key=` is the server's public
    key and is appended to the id. Dart decodes `+` in a query as a space, so
    the key is percent-encoded.
  - `rustdesk://config/…` and `rustdesk://password/…` change settings on
    mobile, and `?password=` passes a password. Cognia never builds any of
    them.
  - Android package `com.carriez.flutter_hbb`; the iOS and Android apps
    register the `rustdesk` scheme.

## Decisions (settled with the user on 2026-10-18)

1. **A web console binding stores the page link the user pasted.** It is
   validated per console profile (`guacamole`, `meshcentral`, `generic`).
   MeshCentral gets `viewmode=11` when the link has none.
2. **No console credentials.** The user signs in inside the console. On the
   desktop the console runs in its own persistent web data store, separate
   from the in-app browser.
3. **On the desktop, the console is a native child webview** inside the
   remote desktop viewer page, with Cognia's toolbar around it. Phones use the
   in-app browser; the Web client opens a tab.
4. **Opening a console or launching RustDesk needs `host.admin`** and a host
   admin lease on a paired device, like a VNC control session: these
   bindings cannot be made read-only. An observe-only device sees the binding
   but not its link or RustDesk ID.
5. **Third-party plugins may register web console providers.** External-app
   providers must name a launcher from a closed Host list, today only
   `rustdesk`, so no plugin can build an arbitrary URI that starts a local
   app.
6. **RustDesk stores the ID, an optional self-hosted server and its public
   key, and no password.**
7. **Phones launch RustDesk through the native `CogniaAppHandoff` plugin.**
   It gains a `rustdesk` target, so the app can tell when RustDesk is
   missing.

## Host (`crates/cognia-remote-desktop`)

1. **Binding access.** `Binding` gains:
   - `access: "bridge" | "web-console" | "external-app"`, defaulting to
     `bridge` so stored Phase 2 targets load unchanged;
   - `console: { url, profile }` for a web console;
   - `launch: { launcher: "rustdesk", peerId, server?, key? }` for an
     external app.

   `endpoint` becomes optional and is absent only for `external-app`. A web
   console's endpoint is derived from its URL (host, explicit or default
   port), then pinned and confirmed like any other: a new address needs
   `confirm`, and loopback, link-local and metadata addresses are refused.
   Non-bridge bindings must use adapter `none`, cannot be view-only and hold
   no credentials. A save that changes a binding's access clears its
   credentials, as an adapter change already does.

2. **`console` module.** `normalize(url, profile, class)` rules:
   - URLs are at most 2048 bytes, `https`, or `http` only when the pinned
     address is private (`remote_desktop_console_url_insecure` otherwise).
   - No user info, and no credential-like query keys (`token`,
     `access_token`, `id_token`, `auth`, `authtoken`, `login`, `logintoken`,
     `password`, `passwd`, `pwd`, `secret`): refused with
     `remote_desktop_console_url_has_credentials`.
   - `guacamole` needs a `#/client/<identifier>` fragment.
   - `meshcentral` needs a non-empty `gotonode` or `gotodevicename`, and adds
     `viewmode=11` when absent.
   - `generic` adds no rule.
   - Any other failure is `remote_desktop_console_url_invalid`.
3. **`launch` module.**
   - The peer ID drops spaces and must match `[A-Za-z0-9][A-Za-z0-9_-]{5,31}`.
   - The server is a hostname, IPv4 or bracketed IPv6 literal, with an
     optional port.
   - The key matches `[A-Za-z0-9+/=]{1,128}`.
   - `rustdesk_uri(..)` builds `rustdesk://connection/new/<id>[@<server>]`,
     plus `[?key=<percent-encoded>]`. `parse_rustdesk_uri` accepts exactly
     that grammar and nothing else. Every client re-checks with it before
     opening, and the native handoff applies the same shape.
4. **Command `remote_desktop_binding_launch { targetId, bindingId }`**
   (verb `launch`).
   - It returns `{ kind: "web-console", url, profile }` or
     `{ kind: "external-app", launcher, uri }`.
   - Refusals:
     - a disabled binding: `remote_desktop_binding_disabled`;
     - a bridge binding: `remote_desktop_binding_not_launchable`;
     - a console whose name no longer resolves to the pinned address:
       `remote_desktop_endpoint_changed`.
   - It needs `host.admin` (`requires_admin`).
   - It is audited as `remote_desktop.binding.launch` with `binding_id` and
     `access`.
5. **Redacted list.** For a principal not admitted to control, `target_list`
   leaves out `console.url` and every `launch` field except `launcher`.
   `console.host` stays, so the console can say where it points.
6. **Probe.** A web console draft is probed like adapter `none`. Resolution
   and classification come first. With `confirm`, the Host makes a TCP
   connect from itself, and the wizard labels that "reachable from the Host".
   External apps have no probe.

## Desktop shell (`src-tauri/src/browser/remote_console.rs`)

- One child webview, label `remote-console`, on the main window. It is driven
  by `remote_console_open { url, bounds }`, `remote_console_set_bounds`,
  `remote_console_set_visible` and `remote_console_close`, following the
  `codeserver_embed_*` placement contract.
  - The URL is re-validated with `cognia_remote_desktop::console::check_open_url`:
    `http(s)`, no user info, no credential query.
  - Navigation stays on `http(s)`; other schemes are refused.
  - New windows are refused, and so are downloads (file transfer is out of
    scope, ADR-0234).
  - There are no init scripts and no IPC: capabilities are local-only.
  - Data store: `data_store_identifier` on macOS 14 and later; a
    `remote-console` data directory on Windows and Linux; incognito on older
    macOS (sign in each time, never the app's default store).
- `remote_desktop_open_app { uri }` re-parses with `parse_rustdesk_uri` and
  opens it through the opener plugin from Rust. The renderer's opener scope
  stays http(s), mailto and tel.

## Client

1. **Types and registry.**
   - `RemoteDesktopBinding` gains `access`, `console` and `launch`, and its
     `endpoint` becomes optional.
   - The provider definition becomes a union by `integrationMode`:
     - `embedded`: as today;
     - `web-console`: `{ consoleProfile }`;
     - `external-app`: `{ launcher: "rustdesk" }`.
   - `IMPLEMENTED_INTEGRATION_MODES` adds `web-console` and `external-app`.
     `native` stays refused, because native providers are the sandboxes
     themselves.
2. **`lib/remote-desktop/launch.ts`.**
   - `launchBinding(host, target, binding)` calls the command, then opens
     what it returned:
     - Tauri: a console goes to the viewer page, and RustDesk goes through
       `remote_desktop_open_app`;
     - Capacitor: a console opens in the in-app browser, and RustDesk goes
       through `CogniaAppHandoff` (`rustdesk` target, with an availability
       check first);
     - Web: a console opens a new tab, and RustDesk is navigated to directly.
   - It re-checks the URI shape locally before opening.
   - It never claims a RustDesk connection was made. The toast says RustDesk
     was asked to connect.
3. **Devices console.**
   - The wizard's provider choice picks the form:
     - bridge: today's fields;
     - web console: link, probe and endpoint confirmation;
     - RustDesk: ID, server, key.
   - Non-bridge rows show a "Permissions managed by the provider" badge and
     one Open button, in place of view and control.
   - An observe-only device sees why Open is unavailable.
4. **Viewer page.** For a web console binding on the desktop, the page asks
   the Host to launch, then reserves the content box for the `remote-console`
   webview. It keeps the toolbar (provider badge, the console host, Reload,
   Close). The webview is hidden while the page is hidden and destroyed on
   leave.
5. **First-party plugins.**
   - `plugins/remote-desktop-web-console/` registers Guacamole and
     MeshCentral.
   - `plugins/remote-desktop-rustdesk/` registers RustDesk.
   - Both are listed in `browser-builtins.json`.
6. **Native handoff.** `CogniaAppHandoff` gains `rustdesk`:
   - Android opens the URI in the RustDesk package, with package visibility
     declared in `<queries>`.
   - iOS asks `canOpenURL("rustdesk://")` and opens with the
     `LSApplicationQueriesSchemes` entry.
   - Both refuse any URI outside the `connection/new` grammar.

## Out of scope

- A Cognia-side guacd or RDP stack.
- MeshCentral login tokens, and RustDesk passwords or options (`relay`,
  `password`).
- Embedding consoles in an iframe.
- Agents on external machines.

## Verification

- `cargo test -p cognia-remote-desktop`: console URL rules per profile,
  RustDesk URI build and parse (including refusing `config`/`password` forms,
  `+` in keys, IPv6 servers), access invariants on save, credential clearing
  on an access change, launch refusals and audit, list redaction.
- `cognia-companion-rpc`: `binding_launch` needs `host.admin` plus a lease.
- Jest for the registry, launch helper, wizard fields, section and viewer
  page; tests for both plugins.
- `pnpm companion-api:check`, the command gates, `plugin:contract:check`,
  `lint:i18n`, `i18n:build:check`, `audit:colocated-tests`.
- Not covered by these tests: a real Guacamole and MeshCentral sign-in in
  the desktop child webview (data store persistence, SSO redirects), and
  RustDesk launching on macOS, Android and iOS. These are offered as a smoke.

## As built (2026-10-18)

Deviations and details beyond the plan above, each pinned by tests:

- **Older Hosts.** `access` is optional on the client. A Phase 3–4 Host sends
  no `access`, and its bindings read as `bridge`. A Phase 2 store file loads
  unchanged.
- **Session and launch refuse each other's bindings by name.**
  `session_open` on a console or app binding answers
  `remote_desktop_binding_not_bridged`. `binding_launch` on a bridge answers
  `remote_desktop_binding_not_launchable`. A saved probe of an external app
  answers `remote_desktop_binding_has_no_endpoint`.
- **Changing kind clears secrets.** A save that turns a bridge into a console
  or an app clears its stored passwords before the store is written, as a
  removed binding's are. Its sessions end with `binding_changed`.
- **Redaction is by grant, not by lease.** The list leaves out `console.url`
  and every `launch` field except `launcher` for a device without `host.admin`
  (`Principal::admitted(Control)`). An admin device sees them without an admin
  lease. The lease still gates the launch itself.
- **The client re-checks before every open.**
  - `isRustdeskLaunchUri` and `isOpenableConsoleUrl` (`lib/remote-desktop/launch.ts`)
    mirror `launch::parse_rustdesk_uri` and `console::check_open_url`.
  - `remote_console_open` and `remote_desktop_open_app` re-check in Rust.
  - Android and iOS `CogniaAppHandoff` apply the same RustDesk pattern. Both
    were checked against the same accept and refuse lists, Swift with a scratch
    `swiftc` build.
- **Desktop console placement.** Calls go through one queue
  (`console-webview.ts`), so a bounds update never reaches the native side
  before its open. A console that finishes opening after the page left is
  closed at once. The webview parks off-screen whenever the window is hidden
  or a dialog, menu or toast overlaps it (`useRegionVisibility`, the
  code-server pane's rule), because a native layer always paints on top.
- **SDK.** `defineRemoteDesktopProvider` is generic over the definition
  union, so a plugin keeps the narrowed kind (`def.viewer`,
  `def.consoleProfile`).

Not verified yet:

- a real Guacamole and MeshCentral sign-in in the desktop console webview,
  covering data store persistence, SSO redirects, and refused new windows and
  downloads;
- the macOS 13 private-session fallback;
- RustDesk launching on macOS, Android (Huawei test phone) and iOS;
- the Android instrumented `CogniaAppHandoffPluginTest`, which needs a device.
