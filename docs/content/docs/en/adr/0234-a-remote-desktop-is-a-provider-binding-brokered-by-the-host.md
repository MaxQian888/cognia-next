---
title: "0234 — A remote desktop is a provider binding brokered by the Host"
description: "Sandboxes and external machines are viewed and controlled through provider bindings the Host owns, one fenced control lease, a Host-terminated data plane and isolated provider plugins. Third-party engines are reused, never reimplemented."
---

# ADR 0234 — A remote desktop is a provider binding brokered by the Host

**Status:** Accepted — the user confirmed every decision on 2026-10-18. Phases 1–4 are implemented; their specs and "As built" notes are `docs/plans/2026-10-18-remote-desktop-phase{1,2,3,4}.md`. Phase 5 is pending.  
**Date:** 2026-10-18  
**Scope:** Viewing and human control of local Docker CUA sandboxes, ADR-0233 managed desktops and user-owned external machines (VNC, Selkies, Guacamole/MeshCentral web consoles, RustDesk launch) from the Tauri desktop, Web and phone clients. Agent computer use on external machines is out of scope.  
**Related:** [0005](./0005-remote-control), [0020](./0020-computer-use-completeness), [0088](./0088-pro-ide-code-server), [0153](./0153-the-host-obtains-the-confirmation), [0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version), [0196](./0196-a-library-crate-links-tauri-only-when-asked), [0214](./0214-the-chat-dock-is-a-tabbed-browser-that-remembers-each-task), [0224](./0224-an-always-on-host-is-a-peer-the-user-brings), [0233](./0233-a-managed-desktop-accepts-a-delivered-commit).  
**Research:** `docs/research/external-remote-desktop-review-2026-10-16.md` (repository and upstream fact check of the original proposal, with citations).

## Decision

Cognia does not become a remote-desktop protocol implementation. It brokers sessions over mature engines. A **remote target** is a reference (a sandbox, a managed desktop, or a user-owned external machine), not a second lifecycle registry. A target has one or more **provider bindings**. The **Host** that can reach the target owns its bindings and credentials, authenticates the protocol, bridges the bytes, holds the single **fenced control lease** and writes the audit. Clients only view and send input through Companion commands and Host-issued tickets. Providers ship as plugins. Built-in providers are first-party plugins that use the same contract as third-party ones.

## Context

The original proposal ("Remote Desktop Framework + Built-in Viewer + External Remote Providers") had the right direction but was not executable. It had factual errors (UU Remote has no public protocol; Selkies `enable_collab` breaks exclusive control; Selkies ships GPL encoders; Guacamole JSON auth exists only in the Java webapp; websockify is the wrong reuse target for a Rust Host). It also missed prerequisites:

- Local `cua_sandbox_*` commands are `internal`/`client`-only, so a phone cannot reach a Host's sandbox.
- Human input bypasses `run_gated` and lease events are never audited.
- No TCP data plane exists.
- `crates/cognia-net/src/egress.rs` `is_forbidden_dest_ip` rejects the RFC1918 ranges where most VNC servers live.

ADR-0233 then added E2B managed desktops: a fenced 15-second lease in `crates/cognia-automation/src/cua_sandbox/managed/control.rs`, a `ManagedDesktopProvider` trait, and `managed_desktop_control_*` commands on http/websocket/webrtc. It also prohibited a raw VNC/RDP endpoint beside the managed computer-server, because that would accept input outside the lease. This ADR builds on 0233 and keeps that prohibition.

## 1. Targets and bindings

| Target kind | Reference | Providers |
| --- | --- | --- |
| `sandbox` | Local Docker CUA connection (`lib/sandbox/`) | Native (frames + input over the lease); Selkies when the image was built with it |
| `managed-desktop` | ADR-0233 desktop identity | Native only, through 0233's control plane |
| `external` | Host-owned record | VNC, web console (Guacamole, MeshCentral), RustDesk launch |

A paired Host's own screen is reached as an `external` target with a VNC server. There is no separate native screen-streaming path. A binding records provider id, priority, a non-secret configuration, a credential reference and the pinned endpoint. Selection is manual or by priority among bindings of the **same** target. A fallback never changes the target and never upgrades view to control.

Targets, bindings and credentials live on the Host that reaches them, in a versioned Host store, with credentials in Host secrets (the `credentialRef` pattern of `lib/remote-host/credential-vault.ts` and 0233's `managed-desktop:` refs). Clients read them through Companion commands. There is no Dexie table and no account sync. Credentials never leave the Host.

## 2. One control lease

`managed/control.rs`'s fenced lease becomes the only control model. Local Docker CUA moves onto it from `desktop_session.rs`. The lease is 15 seconds, renewed every 5 seconds, and bound to principal, target, binding and generation. The fence advances on every invalidation.

- Many viewers, one controller among Cognia-brokered sessions. Takeover is an explicit request; a second human cannot take control silently.
- Human input is an atomic action, so held keys and mouse buttons originate only from agent transitions. The Host tracks that agent-held state and releases it at takeover, preemption and stop; expiry of a human lease cannot leave input held. Uncertain cleanup quarantines the target, as in 0233.
- Takeover fences new agent operations and cancels or waits out the in-flight one under a deadline. It does not simply queue behind it.
- Connections that bypass Cognia (another VNC client, a Guacamole tab) cannot be governed. A binding without server-side control revocation is labelled **provider-managed** in the UI and never presented as lease-protected.

## 3. Permissions and commands

| Action | Capability |
| --- | --- |
| List targets, read status, view frames, open a view-only session | `host.observe` |
| Acquire, renew or release control; send input; open a control session | `host.admin` |
| Create, edit or delete targets and bindings; confirm a LAN endpoint | `host.admin` |

Commands are added to `protocol/companion-commands.json` with verbs from the closed vocabulary (`protocol/companion-verbs.json`, ADR-0175). They are regenerated with `pnpm companion-api:gen`. Sensitive actions keep ADR-0153 Host consent. A shared conversation never grants desktop access.

## 4. The Host terminates the data plane

- **Transport.** On a reachable network, a client opens a Companion WebSocket with a one-time socket ticket (`security_store.rs` issue/redeem, the `ws_terminal.rs` pattern). The ticket is bound to session, target, binding and mode. Over relay, the Host carries the same stream on a dedicated `cognia.rfb` datachannel, classified beside `cognia.terminal` in `crates/cognia-companion-connectivity/src/signaling/peer.rs`. Desktop frames never travel on `cognia.signaling` JSON RPC.
- **Bridge.** A Host-side axum WebSocket↔TCP bridge in the new crate replaces websockify. Revoking the ticket or the lease closes the stream from the server side.
- **Handshake adapters.** Protocol authentication is done by a closed list of Host adapters. The first is `vnc`: the Host completes the RFB handshake and VNC authentication with the server, then offers the client an already-authenticated stream with security type None. Passwords never reach the client or a plugin. `none` is a plain byte pipe. New adapters (`guacd`, …) land in Host code, never in plugins.
- **VNC read-only.** View-only is granted only for bindings whose server enforces it: a TigerVNC view-only password from `vncpasswd`, or x11vnc `-viewpasswd`. The Host authenticates with that password for view sessions. Other bindings offer full control only and say "cannot be made read-only". There is no RFB input-filtering proxy.
- **LAN egress.** A private-address endpoint is allowed per target only after a `host.admin` confirmation. A hostname is resolved at save time and pinned to IP:port; a changed resolution requires re-confirmation. Loopback, link-local and metadata destinations are always refused. The allowance lives in `cognia-net` beside `is_forbidden_dest_ip`. `scripts/gates/check-network-egress.mjs` gains a rule for raw `TcpStream::connect`, so a bridge cannot bypass the policy unnoticed.
- **Frames.** Native targets stay on RPC-polled frames until the Selkies phase.

## 5. Providers are plugins with hard isolation

The remote-desktop provider point is declared in `lib/plugin/contracts/plugin-points.ts`. A provider declares:

- its manifest: integration mode `native | embedded | web-console | external-app`, supported targets, and capabilities including `serverEnforcedViewOnly` and `managedControl`;
- a configuration schema;
- a probe;
- a handshake adapter chosen from the Host list;
- a viewer.

Any plugin may register a provider, but isolation is hard:

- The plugin never receives credentials.
- Network access is only through the Host bridge, to targets the user confirmed.
- Registering a provider grants no access to existing targets.

Built-in providers ship as in-tree first-party plugins under `plugins/` (precedent: `plugins/e2b-sandbox/`), so the contract is exercised by real use. First-party viewers may be React components. Third-party viewers run as sandboxed plugin webviews (`lib/plugin/registries/webview-registry.ts`) that receive the byte stream over a MessagePort.

## 6. Provider positions

| Provider | Position |
| --- | --- |
| Native | Sandboxes and managed desktops over the lease. The viewer becomes a chat dock panel (`ContextPanelDefinition`, `components/artifacts/chat-dock-panels.tsx`) beside `computer-use-picture-in-picture.tsx`, not only Settings |
| VNC | First external provider. noVNC 1.7 is loaded client-only through a dynamic import, because it touches `document` and uses top-level await at import |
| Selkies | Local Docker CUA only, as an opt-in build argument the user builds locally (default encoders are GPL; Cognia does not distribute that image). It attaches to the existing `:99` display, is published on a second loopback port, and runs Secure Mode with `enable_collab=false`. One Host owner serializes the token-table replace. On release the Host revokes the Selkies controller, confirms it, and only then releases the lease. Putting Selkies into managed desktops needs an amendment to 0233. *As built (Phase 4):* the opt-in is a variant image layered on the built-in one (`cognia-cua-desktop:0.3.46-2-selkies-2.0.0`), not a build argument on its Dockerfile, so the default and managed images keep recipe 7; a per-connection switch selects it after a licence notice |
| Guacamole, MeshCentral | Web-console bindings to the user's own server. The desktop uses a native child webview (the `src-tauri/src/codeserver/webview.rs` pattern); the phone uses an in-app browser. Labelled "permissions managed by the provider". No built-in guacd or RDP stack |
| RustDesk | `rustdesk://<ID>` launch where the app is installed. The password is never placed in the URI. Cognia never claims a connection was established |
| UU Remote | Not supported: no public integration protocol exists |

RDP is reached only through the user's Guacamole or MeshCentral, or by installing VNC or RustDesk on the machine.

## 7. Clients

Desktop, Web and phone use the same Companion commands. The static Web build has no server, so it reaches targets only through a paired Host. The phone viewer defaults to trackpad mode (precise cursor), switchable to direct touch, with a special-key bar (Ctrl, Alt, Esc, Tab) and the soft keyboard.

## 8. Audit

The Host persists audit records, following `audit_grant` in `crates/cognia-companion/src/sandbox_previews.rs`:

- session open, close and failure;
- lease acquire, renew, release, expire and takeover;
- human input batches (counts and kinds);
- binding and provider changes;
- LAN confirmations.

Each record carries time, principal, device, target, binding and outcome. Records contain no pixels, credentials or clipboard contents. Clients query the records through Companion. The in-memory `AuditRing` alone is not sufficient.

## Phases

New Rust logic lives in `crates/cognia-remote-desktop/`, registered in `scripts/gates/rust-architecture.json`, with Tauri shells behind its `tauri-host` feature (ADR-0196).

1. **One lease, sandbox gaps, chat dock.** Move local CUA onto the fenced lease, release held keys and buttons, fence in-flight agent actions, add Host-persisted audit, and mount the dock panel.
2. **Framework, plugin API and VNC on desktop.** The Host target store, LAN pinning and its gate rule, the ticketed bridge, the `vnc` adapter, and a first-party VNC plugin.
3. **Web and phone.** Companion transports on the new commands, the `cognia.rfb` channel and the phone viewer.
4. **Selkies** in local Docker CUA.
5. **RustDesk launch and web consoles.**

Each phase ships with co-located tests, i18n in both locales and a changeset. The security tests are:

- a view-only ticket cannot send input when the UI is bypassed;
- a ticket for one target cannot reach another;
- a revoked lease stops input within one call;
- a pinned endpoint refuses a DNS rebind;
- a plugin viewer cannot read a credential.

## Consequences

- The legacy `desktop_session.rs` lease and its `cua_sandbox_desktop_*` commands are retired once Phase 1 migrates local CUA. This supersedes the "15-second human lease" wording for local sandboxes in 0020 and 0233's context section.
- `cognia-net` egress gains its first user-confirmed private-address allowance. Every other caller keeps the deny-by-default rules.
- Third-party provider plugins can extend viewers and configuration but not protocols. A new protocol needs a Host adapter and an ADR amendment.
- Out of scope: agent computer use on external machines, built-in RDP, cross-Host target sharing, recording, file transfer and clipboard sync. Clipboard and file transfer will need their own authorization when they are added.

## Alternatives considered

- **Client-side `viewOnly` as the boundary.** Rejected: noVNC documents it as client behavior only.
- **An RFB input-filtering proxy.** Rejected for v1: no maintained open-source implementation exists, and parsing RFB input adds a large security surface. Server-enforced view-only passwords cover the need.
- **Vendoring websockify.** Rejected: it is Python and LGPL, and the Rust ports are unmaintained. A byte bridge in axum is small.
- **Targets in Dexie with account sync.** Rejected: the Host bridges the connection and owns the credentials. Syncing the list would separate it from the only machine that can use it.
- **A cross-origin iframe for MeshCentral.** Rejected: `X-Frame-Options`, `SameSite=Lax` cookies and WebView third-party cookie limits make it fragile. A child webview uses top-level navigation instead.
