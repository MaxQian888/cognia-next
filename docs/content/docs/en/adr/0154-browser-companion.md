---
title: "0154 — The browser hands over a page, not a session"
description: "A Chrome side panel that pairs with the desktop Host as its own least-privilege device class, captures a page only on an explicit gesture, and turns it into one new Cognia task. It is not a Browser Use dependency, not a second chat client, and not an automation transport."
---

# ADR 0154 — The browser hands over a page, not a session

**Status:** Accepted
**Date:** 2026-08-27
**Related:** [ADR-0055](./0055-agent-browser-loop), [ADR-0085](./0085-cloud-shared-browser), [ADR-0125](./0125-work-submission-contract), [ADR-0136](./0136-cross-device-placement), [ADR-0144](./0144-workspace-as-the-unit-of-work), [ADR-0148](./0148-style-packs-and-surface-tiers), [ADR-0149](./0149-a-person-is-not-a-device)

## Context

There is no way to hand the page you are reading to Cognia. A person copies the
title, the URL and some text into the desktop app, or gives up on that context.

Two research passes framed the answer. The [market
comparison](https://github.com/cognia/cognia-next) of browser AI products found
that "a side panel that answers questions about the current page" is table
stakes — Gemini in Chrome, Edge Copilot, Comet, Dia, Brave, Firefox, Sider all
have it — and that the differentiators are elsewhere: visible context selection,
layered permissions, task-scoped boundaries, take-over, and the ability to route
between local, embedded and cloud browsers. The [Browser Use
study](https://github.com/browser-use/browser-use) established the negative
result that matters more: Browser Use does **not** need a Cognia extension.
Its transport is CDP. Cognia already has three browser paths — `EmbeddedEngine`,
`RemoteChromiumEngine`, and the `playwright-existing-browser` MCP preset — and an
extension is a fourth product surface, not a missing prerequisite for any of
them.

So the question was never "how do we automate a browser". It was "how does a
page get into Cognia", and that is a much smaller thing to build correctly.

## Decision

**1. The extension hands over a page. It never drives one.**

First release captures in three modes — `metadata`, `selection`,
`readable-page` — always after an explicit gesture (toolbar, keyboard shortcut,
context menu), never on tab change. No `chrome.debugger`, no static content
scripts, no `<all_urls>`. `activeTab` plus an optional `http://127.0.0.1/*` host
permission is the whole install-time ask.

Page actions, approvals, resuming an existing session, screenshots, and any CDP
relay are out of scope and must not be pre-wired. Where automating a logged-in
tab is the goal, `playwright-existing-browser` already does it and keeps that
transport Microsoft's problem rather than ours.

**2. A browser is its own device class, with two capabilities and no others.**

`browser.submit` and `browser.read-own` join the SecurityStore vocabulary, and
no `GrantKind` maps to either — they are granted only by consuming a token from
a dedicated `browser_enrollments` table through
`POST /api/auth/browser/register`. This is `agent.worker`'s shape verbatim, and
for the same reason: the device class is decided by which enrollment was spent,
never by a label the client chose.

A browser device therefore has no `agent.run`, no `workspace.*`, no
`terminal.open`, no `process.spawn`, no `host.observe`, and no Owner authority.
The tests assert the absence, because the absence is the point.

**3. The extension origin is bound at registration and replayed on every
request.**

`WebOriginPolicy` classifies a request with no `Origin` header as `Native` and
allows it — the right default for a native client, the wrong one for a device
that is definitionally a browser, and reachable in practice because an MV3
service worker's `fetch` may omit the header. The registered
`chrome-extension://<id>` rides on `AuthorizationSnapshot` and is compared on
every authenticated request. It is `None` for every other device, so nothing
else changes behaviour.

Admission for that origin is a **new predicate**, not a widening of
`is_secure_or_loopback`: `lark_entry` shares that function to validate its
`COGNIA_LARK_*` base URLs, and teaching it about extension schemes would teach
Lark that an extension page is an acceptable webhook base.

**4. The pairing code names the plaintext loopback listener, and refuses to
exist without it.**

A tab cannot reach the HTTPS companion plane at all: the certificate is
self-signed with no CA, and a browser validates against system roots with no
JS escape hatch. `http://127.0.0.1` is "potentially trustworthy" per Secure
Contexts and needs no chain, which makes `browser_access`'s listener the only
door. `companion_create_browser_enrollment` therefore emits that base URL and
refuses to mint a code when the listener is not bound — a code that cannot
connect sends the user to the extension to discover a failure whose cause lives
in Settings.

The payload has its own header (`cgnb1|`) rather than a mode on `cgnp3|`,
because the two are not interchangeable in either direction and a shared header
would let each be pasted where it silently cannot work.

**5. Submission creates the session directly and enqueues one message through
HostState.**

Handing both halves to HostState is wrong twice. `session.create` maps to
`process.spawn` — the Agent Control grant — and its projection writes a bare row
with no workspace, no execution context and no `SESSION_CREATED` event, so the
conversation would exist without belonging anywhere. `startNewSession()` is what
makes a session real.

The message half does go through HostState, because its dispatcher is the only
non-React path from "a message exists" to "a turn is running": it accepts into
the ADR-0125 WorkSubmission ledger, claims a dispatch lease, resolves send
options, and calls `sendPrompt` — which is where the PII gate lives.

`message.enqueue` requires `workspace.write`, which a browser does not hold, so
the enqueue is submitted on the **Host's** authority. That is not a bypass, and
the reason is structural rather than a promise: the action is built by the Host
for a session it just created, with a fixed intent kind and a one-element batch.
The caller supplied an instruction and a captured page; it named no session and
chose no intent. `browser.submit` is the capability for that one closed effect.
If a second intent kind is ever needed, the caller stops being constrained and
the model must change.

**6. Idempotency is the command manifest's, not hand-rolled.**

`browser_context_submit` declares `idempotency: "required"`, which puts it on
the durable operation ledger: a repeated `Idempotency-Key` replays the original
receipt instead of creating a second session, and a reused key with different
arguments conflicts. The submission id **is** the idempotency key, so a retry
cannot present a fresh one for the same user action, and the message id is
derived from it so a redrive resolves to the same transcript entry.

**7. Reads are scoped to the calling device, and say nothing about others.**

`browser.read-own` means the submissions this device made. A submission
belonging to another device answers exactly as a missing one does — telling them
apart would let one browser probe another's ids.

**8. The captured page is fenced; the instruction is not.**

`buildBrowserContextPrompt` wraps the page in
`<untrusted_content>` (ADR-0008 R7's wrapper) and leaves the user's instruction
outside it. The banner-style wrapper in `lib/web/untrusted-content.ts` could not
express this: everything after a banner reads as untrusted, so the instruction
would be quarantined with the page.

**9. The task's landing place is a workspace, not a runtime target.**

The four `runtimeTargetId` values name a *client's* execution identity, and
`resolveRuntimeTarget()` returns `null` for `tauri` precisely because that shell
**is** the host. An extension executes nothing. What the user actually chooses is
a workspace (ADR-0144), which is what the request carries.

**10. The side panel's appearance is sent by the Host, not compiled into the
extension.**

The capability response carries the resolved palette — every custom property in
`theme-token-catalog.ts`, produced by the same `resolveAppPalette` that paints
the app — plus the ADR-0148 radius base, pill radius and density. A copied
palette would be a second source of truth *and* wrong for this user, because
presets, custom themes, imported VSCode themes, plugin themes and a11y patches
all resolve into it and none of that is knowable at the extension's build time.

**11. Status is polled while the panel is visible. This is deliberate.**

`/ws/events` exists, but its socket channel requires `host.observe` — the whole
host event stream, far wider than this device should see — and an MV3 service
worker is reclaimed at will, so a background socket cannot be relied on. The
panel polls `browser_context_list` while visible and reconciles on open. A
dedicated `SocketChannel::BrowserSubmissions` is a reasonable later addition and
is recorded here as deferred rather than left unexplained.

## Consequences

Cognia gains a browser entry point without gaining a browser automation
surface, and without the install-time permission warnings that would come with
one. The extension can be reviewed by reading its manifest.

The cost is a fourth browser-adjacent surface to keep coherent with three
existing ones, and a device class whose two capabilities must be maintained
alongside the twelve that predate them.

The polling choice is a known compromise. If the recent list becomes something
people watch rather than glance at, the socket channel in §11 is the fix.

## Rollout

Internal only. Browser Access is off by default, the extension is distributed
through an unlisted store listing, and the Host keeps a kill switch that stops
enrollment and submission while leaving existing sessions reachable.
