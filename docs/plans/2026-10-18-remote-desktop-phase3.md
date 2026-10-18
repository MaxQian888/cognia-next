# Remote desktop Phase 3: Web and phone (ADR-0234)

Phase 2 shipped the Host target store, the VNC bridge and the provider plugin
point for the desktop's own renderer. Phase 3 lets every client that reaches a
Host use them: the phone and Web clients paired to it, and a desktop managing
another Host. The Host keeps owning targets, credentials, the lease and the
audit; only the viewer moves.

## Host

1. **Process-wide install.** `cognia_remote_desktop::install(state)` /
   `installed()` replaces `app.manage(RemoteDesktopState)`. The desktop startup
   and `cognia-server` both install it, so a headless always-on Host can bridge
   its LAN too.
2. **Principals.** A session belongs to the principal that opened it:
   `local-owner` for the desktop's own user, `device:<deviceId>` for a paired
   device. Renewing or closing another principal's session answers
   `remote_desktop_session_not_found`. Leases are issued to the principal, and
   every audit row names it.
3. **Remote admission** (`crates/cognia-companion-rpc/src/remote_desktops.rs`).
   The caller must be an active paired device, not a worker device and not the
   `service` scope: agents never drive external machines (ADR-0234).
   - `host.observe`: list targets, renew/close own sessions, open a `view`
     session.
   - `host.admin` plus a host admin lease (ADR-0153): save, delete, set a
     credential, probe, and open a `control` session. `session_open` declares
     `host.observe`; `payload_capability` escalates anything that is not
     literally `"view"` to `host.admin`, and the domain dispatcher requires the
     admin lease for it.
   - Every remote session re-runs its admission once a second (device still
     active, still holds the mode's capability, still not a worker). A failure
     ends the session with reason `revoked`. The admin lease gates opening; the
     session then lives on renewals and the capability grant.
4. **Bridge attachment.** A bridge either listens on loopback (the desktop
   renderer, unchanged) or waits for a remote attach:
   `RemoteDesktopHost::attach(session_id, principal, stream)` within the 30 s
   ticket TTL, once. The stream is an in-memory byte pipe the transport adapter
   pumps; the bridge never sees transport types. `SessionOpened.url` is set only
   for loopback; remote sessions carry `transport: "companion"`.
5. **LAN.** `POST /api/auth/socket-ticket { channel: "remote-desktop",
sessionId }` issues a ticket bound to `/ws/remote-desktop/{sessionId}`,
   audience `remote-desktop`, capability `host.observe`.
   `GET /ws/remote-desktop/{sessionId}?ticket=` redeems it and attaches as the
   ticket's device. Binary frames only, 1 MiB cap, `binary` subprotocol; a
   refused attach is answered with an HTTP status before the upgrade (see As
   built).
6. **Relay.** A reliable, ordered `cognia.rfb` datachannel per session, opened on
   demand on the live peer (the SCTP association already exists, so no
   renegotiation). The first message is text `{"type":"attach","sessionId"}`
   within 10 s; the Host answers text `{"type":"attached"}` or
   `{"type":"error","code"}` (then closes). After that both directions are
   binary RFB bytes, at most 16 KiB per message, with bounded queues; overflow
   closes the channel, as `cognia.terminal` does. The peer binds the channel to
   the signaling device id; the attach checks session ownership.
7. **Commands.** The eight `remote_desktop_*` commands become `target:
"execution"` over `http`, `websocket` and `webrtc`. The desktop calls them
   through `remote_desktop_local_call { name, args }` (`client`, `internal`), as
   `managed_desktop_local_call` does. Request and response schemas are added;
   headless dispositions move from `local-only` to covered.

## Client

1. **Host ref.** `lib/remote-desktop/host-client.ts` takes
   `{ kind: "local" } | { kind: "remote"; hostRef }`. Remote calls go over
   `withManagementChannel(hostRef)`; admin operations carry a host admin lease
   (`issueHostAdminLease`), cached per transport like the managed desktop
   client.
2. **Stream.** `lib/remote-desktop/stream.ts` turns an opened session into what
   a viewer connects to: the loopback URL; a `wss://…/ws/remote-desktop/…` URL
   when the transport is on a connected LAN; otherwise an attached `cognia.rfb`
   `RTCDataChannel`. noVNC accepts a URL or a channel, so the viewer prop
   becomes `connection: string | RTCDataChannel` (SDK contract updated), and
   the third-party port relay accepts both.
3. **Touch.** The VNC viewer gains phone controls in control mode: trackpad mode
   by default on coarse pointers (relative cursor with a drawn pointer, tap to
   click, two-finger tap for right click, two-finger drag to scroll), switchable
   to noVNC's direct touch; a key bar with latching Ctrl / Alt / Meta, Esc, Tab,
   arrows and Ctrl+Alt+Del; and a soft-keyboard toggle that sends typed text as
   keysyms.
4. **Devices console.** The `remote-desktop` section also renders on a
   `remote-host` row with a management ref (a store Host or the connected
   `/pair` Host). A Host too old to know the commands says so instead of
   failing. The viewer href carries the host ref. A phone's or browser's own
   row says remote desktops are reached through its paired Host.

## Out of scope

Selkies (Phase 4), RustDesk launch and web consoles (Phase 5). Agents on
external machines stay out of scope.

## Verification

- `cargo test -p cognia-remote-desktop`: ownership, remote attach (once, right
  principal, within TTL), revocation ends a session.
- `cognia-companion`: the socket-ticket binding, the WS route refusing a wrong
  session or device, the `cognia.rfb` label contract and attach handshake.
- `cognia-companion-rpc`: admission (worker refused, view vs control
  capability, admin lease for control).
- Jest for every touched TS file; `pnpm companion-api:check`,
  `pnpm audit:rust-architecture`, `pnpm lint:i18n`, `pnpm i18n:build:check`,
  `plugin:contract:check`.
- Not covered here: a real phone over relay and a real VNC server; offered as a
  smoke after the phase.

## As built (2026-10-18)

Deviations from the plan above, each pinned by tests:

- **A refused LAN attach never upgrades.** The route redeems the ticket and
  attaches before answering the upgrade, so a refusal is an HTTP status, not a
  close reason: `401` for a bad ticket, `404` for an unknown session or one
  another device owns, `403` when the device's admission fails, `409` when the
  session already has a viewer, `503` when the Host has no remote desktop
  service. A browser cannot read a WebSocket close reason reliably anyway.
- **Reliability is half checked.** webrtc-rs 0.21 reports
  `max_retransmits: None` for every channel the remote end opens, so the Host
  can refuse an unordered `cognia.rfb` (or `cognia.terminal`) channel but cannot
  tell a partially reliable one from a reliable one. This predates Phase 3;
  the client always opens the channel reliable and ordered.
- **Buffered channel.** The Host sends the RFB banner right after
  `{"type":"attached"}`, before React has mounted the viewer. The client wraps
  the channel in `BufferedRfbChannel`, which holds messages until noVNC installs
  `onmessage` and splits outgoing writes at 16 KiB.
- **Local calls go through one command.** The eight Tauri handlers are replaced
  by `remote_desktop_local_call { name, args }`, which dispatches through the
  same typed DTOs (`deny_unknown_fields`) as the remote router, as the local
  owner principal.
- **Phone shell.** `/devices/remote-desktop` is a full-viewport route without
  the tab bar, sized to the visible viewport, so the soft keyboard pushes the
  key bar up rather than covering it. The key bar listens to native
  `beforeinput` (React's synthetic event lacks `inputType`) and sends
  composition results on `compositionend`, so IME input arrives as Unicode
  keysyms.
- **Off the desktop a link must name a Host.** The viewer route needs `?host=`
  anywhere but the desktop app; without it the page says to open the target from
  its Host in Devices.

Not verified yet: a real phone over relay and a real VNC server, on top of the
Phase 2 smoke items.
