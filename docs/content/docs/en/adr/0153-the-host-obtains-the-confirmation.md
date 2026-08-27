---
title: "0153 — The host obtains the confirmation"
description: "host_admin_lease_issue took its interactive approval as an argument the caller set, and the only client set it to true. The confirmation now happens on the host: a recorded request, an answer from a human who is not the requester, and an approval consumed exactly once."
---

# ADR 0153 — The host obtains the confirmation

**Status:** Accepted
**Date:** 2026-08-27
**Related:** [ADR-0009](./0009-platform-connectors), [ADR-0059](./0059-server-ops-controller), [ADR-0136](./0136-cross-device-placement), [ADR-0152](./0152-connector-controls-name-their-host)

## Context

`host_admin_lease_issue` mints the short-lived, device-bound lease that every
step-up command demands: skills installation, external-bridge control, and
since ADR-0152 the connector keyring. Its manifest entry declares
`approval: interactive`.

It was not interactive. The approval was a boolean **argument**:

- `admin_lease::issue` rejected `confirmed: false`.
- `authorize_approval` special-cased the command and accepted
  `args.confirmed == true` in place of the lease every other `interactive`
  command must present.
- `lib/tauri/admin-lease.ts` — the only caller — wrote `confirmed: true`
  unconditionally, and its test asserted that it did, under the name "binds the
  explicit confirmation".

So the caller asserted its own confirmation and the host believed it. Three
layers agreed, and none of them was a check. The lease's real authority was the
standing `host.admin` capability; the interactive half was decoration.

This was not urgent while the reachable step-up surface was skills and the
external bridge, both of which a device rarely touches. ADR-0152 put credential
read and write on the device plane, which made it the gate standing between a
paired browser and every bot token on the host.

## Decision

**1. The confirmation is obtained, not asserted.**
`companion_api::host_consent` records that a device asked for a lease over a
named operation set, publishes the ask, and hands the answer back exactly once.
`host_admin_lease_issue` no longer reads `confirmed` — the argument is gone from
the request schema, from `admin_lease::issue`'s signature, and from the client.
`authorize_approval`'s special case remains, but now says the honest thing: the
command that mints leases cannot present one, and its approval is enforced in
the dispatch arm.

**2. The approver is never the requester.**
A paired device holding `host.admin` may answer someone else's request and never
its own; `host_consent_pending` filters the caller's own asks out of the list it
returns, so the UI cannot offer an action the host is about to refuse. `owner`
and `service` scopes are exempt — the Owner API's DPoP-proved principal and the
loopback console are outside the device plane and have no device to impersonate.

**3. The tenant's Owner device is its own root.**
An Owner device reaches `_rpc` with `scope: "device"` like everyone else, so
without this it would face the same prompt as a member. Two things make that
wrong rather than strict. A fresh headless deployment has exactly one paired
device: requiring a second one to exist before the first can configure anything
means nothing can ever be configured. And asking the Owner to approve *itself*
is precisely the self-attestation this ADR removes, reintroduced one layer up.

`host.admin` is not the same test. It is a capability an Owner may grant to a
member, and a member holding it still needs someone to approve its escalations —
which is decision L23 from the connector audit: configuring a connector is
administrator work, and a member device does it under an administrator's eye.

**4. One approval buys one lease.**
`take_approved` consumes the record. The lease then supplies the window — ten
minutes by default, thirty at most, revoked when the device disconnects — so the
approval itself has no reason to outlive the moment it is spent. A retry after
the lease lapses asks again.

**5. Asking is idempotent; answering is not.**
A device learns it needs consent by being refused, so it retries. An open
request for the same device and the same operation set is returned as-is rather
than queued a second time — otherwise a settings dialog that re-mounts would
face the approver with a list of identical rows bearing different codes. An
answered request, by contrast, is final: a denial that could be overturned by
anyone still holding the code is not a denial.

**6. One channel, both hosts, and the frame is only a nudge.**
`host-consent://requested` carries the ask and its answer. The desktop emits it
and the `event_channels` forwarder relays it to paired devices; a headless host
publishes to the bus directly, because it has no Tauri runtime to emit from.
Subscribers re-read `host_consent_pending` rather than rendering the payload:
the frame reaches every subscriber including the device that asked, and only the
host knows what a given device may act on. That also makes the read the
capability probe — a refusal renders nothing, which is the correct UI for "you
are not the approver".

**7. The approver surface is one component on every shell.**
`HostConsentPrompt` mounts in `app/layout.tsx`, not behind
`DesktopOnlyInitializers`. On a headless deployment the host has no screen, so
another paired device is the only interactive approver there is — and a
desktop-only prompt would have left that deployment with a gate nobody could
open.

## Consequences

- A member device configuring a connector from a phone now waits for an
  administrator to answer. That is the intended cost; the alternative was a
  standing grant with no time limit and no second party.
- The `stored` credential field gained a sibling, `awaiting-consent`. Both mean
  "not readable here", but only one of them ends by itself, and rendering them
  identically told the operator to give up on the one that was about to succeed.
- `host_admin_lease_issue`'s response is typed (`HostAdminLease`) instead of
  `LegacyRecord`, which pays down one row of the response-schema debt the
  ratchet tracks.
- **The console fallback is not implemented.** `cognia-server admin approve
  <code>` was the plan's answer for a deployment whose only paired device is the
  one asking. Decision 3 removes the case it existed for — that device is the
  Owner — so what remains is a deployment where the Owner is offline and a
  member is asking, which resolves when the Owner returns. The short code is
  minted and published regardless, so the fallback can be added without a
  protocol change.
- Approvals live in memory. A host restart drops open asks and uncollected
  approvals, and the requester's next retry asks again. Persisting them would
  buy nothing: the lease they grant does not survive the restart either.

## Alternatives considered

**Keep `confirmed` and make the client prove it.** There is nothing a client can
send that a client cannot fabricate. The confirmation has to be observed by the
party being asked to trust it.

**Reuse the automation `ConsentBroker`.** It already has the prompt, the
overlay, the mobile sheet and a resolve command. It is also `headless_unsupported`
by construction — both its arms take a `tauri::AppHandle` — so reusing it would
have delivered the desktop half and left a cloud deployment with no approver at
all, which is the half that needed this most.

**Require consent from every device including the Owner.** Stricter on paper,
unusable in practice: the first device on a fresh deployment would have nobody
to ask, and the only escape would be a console command that does not exist yet.
