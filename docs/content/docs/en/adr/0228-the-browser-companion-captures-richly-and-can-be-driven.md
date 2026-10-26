---
title: "0228 — The Browser Companion captures richly and can be driven"
description: "Supersedes ADR-0154 §1, §2 and §11. The extension captures readable Markdown, transcripts, several tabs, screenshots, PDFs and images; reports status in the background; and, when the Owner allows it per browser, becomes a fifth BrowserEngine backend that runs the existing overlay in the user's own tabs over a device-bound socket — without chrome.debugger."
---

# ADR 0228 — The Browser Companion captures richly and can be driven

Repository ownership (2026-10-23): the complete extension and its Chromium tests now live in [cognia-labs/cognia-browser-extension](https://github.com/cognia-labs/cognia-browser-extension). The Host and pinned consumer-compatibility CI remain in this product repository. Extension source paths below refer to that standalone checkout.


**Status:** Accepted
**Date:** 2026-10-16
**Supersedes:** ADR-0154 §1 (hands over, never drives), §2 (two capabilities), §11 (polling only while visible)
**Amends:** ADR-0201 (a fifth engine backend; its rejected `chrome.debugger` alternative stays rejected)
**Related:** ADR-0055, ADR-0072, ADR-0125, ADR-0144, ADR-0198, ADR-0214

## Context

ADR-0154 shipped a side panel that hands one page to Cognia as text. A
comparison on 2026-10-16 against the ChatGPT extension (1.26, 2026-10-15),
Claude in Chrome (1.0.100), Gemini in Chrome, Copilot in Edge, Perplexity,
Monica, Sider, MaxAI, Merlin and the Obsidian / Notion / Readwise / Raindrop
clippers found the panel behind on four axes:

1. **What a capture carries.** Every product sends the readable article, not a
   flat dump of visible text; clippers keep it as Markdown with metadata.
   ChatGPT, Gemini, Sider and Merlin take several tabs at once. Gemini, Claude,
   Monica, Sider and MaxAI take a screenshot or a region. YouTube transcripts
   and PDFs are table stakes.
2. **How a capture starts.** Right-click on a link or an image, quick actions
   (summarize, explain, translate), saved prompts, more shortcuts, an omnibox
   keyword.
3. **What happens after.** Answers render as Markdown, refresh while the task
   runs, take a follow-up, and announce completion through a badge and a
   notification when the panel is closed.
4. **Acting.** ChatGPT, Claude, Gemini, Copilot and Comet all drive the user's
   own logged-in tabs.

The same audit found defects: the companion router's 64 KiB public body cap
refused any `browser_context_submit` above it although the contract promised
192 KiB; `suggestedTitle` was never sent; the recent list never paged.

Cognia already drives the user's Chrome through `user-chrome`
(`connectOverCDP` over Chrome's consent-gated remote debugging, ADR-0201). That
needs a switch flipped in `chrome://inspect` and binding a pane in the desktop
app. ADR-0201 rejected a `chrome.debugger` extension because the permission
cannot be optional and its install warning ("read and change all your data on
all websites") would apply to everyone who only wants capture.

## Decision

### 1. Capture is richer, and still reviewed before it is sent

The extractor runs where layout exists, as before, and adds:

- **`article`** capture mode: the main content (readability-style scoring over
  visible blocks), rendered to Markdown with headings, lists, links, block
  quotes, code and tables. `readable-page` stays for "everything visible".
- **Selection as Markdown** alongside its plain text.
- **Metadata**: byline, published time, site name, language, description and
  canonical URL from `<meta>`, Open Graph and JSON-LD.
- **Transcript** for a YouTube watch page, from the caption track the page
  already exposes, with timestamps; "no captions" is a stated outcome, never a
  silent empty field.
- **Link and image context** from the context menu.
- The user may edit the title and trim the text before sending.

All of it is optional on the wire. The Host advertises what it understands in
`capability.features` and `supportedCaptureModes`; the panel sends only what
the Host listed, so an older Host never silently drops an article it was sent.
`schemaVersion` stays `1`.

### 2. Several tabs can be one submission

`additionalContexts` carries up to `limits.maxPages − 1` more pages, under a
total byte budget `limits.totalContextBytes`. Listing tabs needs the optional
`tabs` permission and reading another tab needs that origin's optional host
permission; both are requested in the panel, inside the gesture, when the user
first adds a tab. Install-time warnings do not change.

The Host fences **each page separately** with `wrapUntrusted`: a shared fence
with "Page 2 of 3" labels inside it could be forged by page text. The
submission fingerprint covers the ordered URL list.

The companion router gives `browser_context_submit` its own body ceiling equal
to `limits.requestBytes`, which is where the contract always said the limit was.

### 3. Attachments ride the Host's own upload staging

Screenshots (visible area, a region cropped in the panel, or a stitched full
page), the PDF a tab is showing, and an image picked from the context menu
become attachments. The extension uploads them with
`browser_attachment_upload_{init,chunk,commit,abort}` under `browser.submit`,
keyed by submission id; the Host stages the bytes in the existing
session-attachment store under its own `host:browser-companion` caller and binds
them to the conversation when the submission lands. `message.enqueue` still
carries refs, never bytes, and the per-file and per-message ceilings are the
composer's. `browser.submit` remains one closed effect: the attachment can only
belong to a submission this device is making.

### 4. Status reaches the user when the panel is closed

The service worker polls on `chrome.alarms` (one minute) while any submission is
non-terminal and the panel is not visible, and the device socket (§5) pushes a
change hint when it is connected. The toolbar badge counts running and
waiting-for-input tasks. System notifications for completed, failed and
needs-input are opt-in: `notifications` is an optional permission requested
from the settings toggle.

### 5. A browser device has a socket, and may be allowed to be driven

`/ws/browser-companion` is a device-bound channel on the `ws_worker` pattern:
a single-use ticket, a hello within ten seconds, authorization re-checked every
second, a bounded outbound queue, and closure on revocation or when Browser
Access is switched off. It needs `browser.read-own`, and carries status hints to
any paired browser.

A policy close code alone is not trusted to be standing. A Host that is stopping closes
every socket with 1001 (going away) before it clears the Browser Access flag, and
the extension reconnects on its normal backoff; a 1008 close (replaced, revoked,
switched off) is retried on the same backoff, and the ticket exchange decides:
it refuses by name — `device_unavailable`, `browser_submissions_disabled`, … —
and only such a standing refusal waits the long interval. The ticket exchange
refuses this channel while Browser Access is off, so a socket is never opened
only to be closed a second after its welcome.

The envelope remains v1. Driving additionally requires `agent-safe-v1` in the
extension's hello features and the Host's selected `welcome.agentProfile`.
Legacy or unknown profiles remain status-only; the Host refuses operation
dispatch before queueing, and the extension refuses execution. An incompatible
envelope (including a protocol-error close) stops automatic retries until an
explicit reconnect. The extension uses application close code 4002, which is
legal for browser clients. `packages/companion-client/src/browser-agent-protocol.json`
pins the version, profile, operation vocabulary and overlay ABI. Both peers test
against it; the extension verifies the injected overlay's ABI before page actions.

A restarted Host signs access tokens with a new key, so every token cached
before the restart is refused with `invalid_access_token`. The client drops
that token and re-authenticates once — the refusal comes from the auth layer
before any command runs, so the resend cannot repeat a write — instead of
failing every request until the old token would have expired. Changing Browser
Access from the desktop or over the host-admin RPC applies the switch at once
through one function (`browser_access::save_and_apply`), so a headless Host
switched off remotely stops taking submissions and socket tickets without a
restart.

Driving is a third class capability, **`browser.drive`**. It joins the browser
class (so the store's class confinement admits it) but is **not** granted at
enrollment: the Owner turns it on per browser in Settings (on a headless Host,
with `cognia-server devices grant --browser-drive`, §9). The Host only sends
operation frames to a connection whose device holds it at send time.

### 6. The extension is a fifth `BrowserEngine` backend

`ExtensionBrowserEngine` (`backend: "extension"`) implements `BrowserEngine` by
sending operation frames over that socket. The extension executes them with
`chrome.scripting` and the **same** `overlay.injected.js` the embedded engine
uses — in the isolated world for snapshot, refs, actions, find and waits, and in
the main world only for the console / network / dialog hooks that must observe
the page's own globals. So refs, generations, secret redaction and
`browser_stale_ref` mean what they mean everywhere else, and all 43 `browser_*`
tools work unchanged.

What needs the debugger protocol is refused with `browser_feature_unsupported`
naming the backend that has it, exactly as `RemoteChromiumEngine` does: printing
to PDF, device emulation, request bodies, password autofill and listing
extensions. Input events are synthetic; a page that insists on trusted input
fails visibly, and `user-chrome` remains the fallback with real input.

The engine is chosen explicitly (`browser_open` with `backend: "extension"`) or
by the conversation a browser started as a **`browser-agent`** delivery target,
which binds that conversation to the device and its starting tab and adds the
browser tools to the run through an ADR-0198 capability grant — never by
editing resolved send options.

### 7. The person stays in charge of every site

Driving requires the optional `<all_urls>` host permission, requested once when
the user enables agent mode in the panel. On top of it the extension keeps its
own per-site decision — allow once, always allow, or never — asked in the panel
the first time an operation targets an origin. A pending decision with the panel
closed raises the badge and, when allowed, a notification; it times out to
`browser_site_permission_required` rather than proceeding. Agent-opened tabs go
into a "Cognia" tab group and are the only ones `finalizeTabs` closes. While an
operation runs, an in-page bar says Cognia is acting. **Stop** cancels the turn
and pauses execution; **Take over** pauses execution. Both cancel pending work,
refuse further operations with `browser_user_takeover`, and retain a paused bar
until the person presses **Resume**. Release/finalize and new-tab claiming also wait for Resume, so cleanup cannot erase
the pause or close tabs under human control. Drive revocation, disconnect and disabling
agent mode cancel pending work too, including site questions. Cancellation is
checked before and after asynchronous browser boundaries; Chrome calls already
dispatched cannot be recalled. Password and one-time-code fields stay human input
(`browser_human_input_required`), and `browser_evaluate`, file and download
tools keep their per-call approval.

Pauses survive idle-session sweeping. The worker owns session and permission
writes; panel decisions are serialized through it, and messages from page content
cannot grant permission. Trusted Stop/Take over gates and cancels work immediately,
including while an older control is painting its bar; control persistence and
cleanup remain ordered. Cancelled mutations cannot erase a newer pause or question.

The Host rechecks authorization at the actual socket send. Its connection records
the unique audit ID of the device's last authorization mutation, so a separate CLI
process cannot revoke and regrant in the same second to revive old work. Lifecycle
changes and the Browser Access switch retire old connections as well. A SQLite
IMMEDIATE transaction excludes cross-process authorization writers during the
synchronous send; deadline and caller cancellation are checked after acquiring it.
Authorization changes close the old connection with code 1008 and require fresh
negotiation. Queued time is subtracted from the transmitted operation budget;
the extension applies that budget across permissions, storage and native API phases.

### 8. Drafts survive closing the panel, not the browser

An unsent capture and its instruction are kept in `chrome.storage.session`:
memory only, cleared when the browser exits, never written to the profile. The
public pairing record, appearance, preferences, saved prompts and the site
decisions live in `chrome.storage.local`; captured content never does.

### 9. A headless Host offers agent mode too

`cognia-server` serves the same device socket, and its brain is where that
Host's conversations run, so agent mode is a Host property rather than a
desktop one. The brain reaches the socket over its own server's service plane:
`companion_browser_extension_status`, `_read`, `_call` and `_notify` are
`target: service` commands (`rpc/service_plane.rs`), so no paired device can
drive another device's browser through them, and every operation still checks
`browser.drive` and the Browser Access switch. Operations are split by effect
(`READ_OPERATIONS`): a look — snapshot, screenshot, waits, page, console,
network, cookie and storage reads — travels as `_read`, a read the Host's
durable idempotency ledger never stores; anything that acts travels as
`_call`, whose receipt the ledger keeps so a retried click is not clicked
twice. Sending everything as `_call` would write page content and cookie
values to the security store on every look; sending everything as a read would
let a retry repeat an action. Each command refuses the other half with
`browser_operation_wrong_command`. The desktop's IPC has no ledger and sends
every operation as `_call`. A refused
operation keeps its code (`browser_drive_forbidden`, `browser_extension_offline`,
…) and travels with a status that says whose problem it is: the request (400),
the Owner's grant (403), the browser's connection (503, retryable), a timeout
(504) or the page itself (422).

The same Host runtime that rebinds agent conversations and hints browsers runs
in the brain as `browser-companion-agent`
(`lib/headless/runtimes/browser-companion-agent.ts`). It and the engine reach
the socket through `lib/browser-companion/host-transport.ts`: Tauri IPC on the
desktop, which always asks its own server even while the window drives a
remote Host, and the installed service-plane transport in the brain. A file
the agent uploads into a page is read from the Host's own disk on either. A
conversation bound to a browser is routed to the extension before the host
profile is considered, because a headless profile otherwise sends browser
tools to the remote browser.

A headless operator grants driving with
`cognia-server devices grant <browser-id> --browser-drive` (and takes it back
with `revoke`); the store still refuses `browser.drive` for anything but a
browser. Listing paired browsers and changing the grant stay desktop commands:
`cognia-server devices grants`, `GET /api/devices` and
`PUT /api/devices/{id}/capabilities` cover them on a headless Host.

## Consequences

The extension now asks for more, but only when used: `tabs`, origin access,
`<all_urls>`, `notifications`, `downloads` and `cookies` are optional and
requested in the gesture that needs them; turning agent mode off gives
`<all_urls>` back. The install prompt is unchanged apart from
`tabGroups` and `alarms`, which carry no warning. Incognito stays
`not_allowed`.

A browser device can now cause actions on the web. The capability is off by
default, granted per device by the Owner, re-checked per frame, revoked with the
device, and refused wholesale by the Browser Access kill switch.

Synthetic input is weaker than CDP input. We accept that rather than give every
user the debugger warning; `user-chrome` covers the remainder.

## Rollout

Same as ADR-0154: internal, unlisted listing, Browser Access off by default.
`browser.drive` additionally defaults off per device.
