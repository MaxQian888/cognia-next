---
title: "0190 — Notifications leave the app as durable work"
description: "The V1 notification center was an inbox with a fire-and-forget IM side-channel: a desktop toast and a best-effort Feishu message shared no identity, no retry, no record of what actually sent, and no policy between 'the run finished' and 'the user's phone buzzed'. V2 keeps the center as the canonical inbox and adds a commit-first durable pipeline behind it — facts are derived synchronously inside the run journal commit, a pure policy engine decides each route's verdict, and governed delivery intents ride the existing outbound queue (or a one-way Feishu webhook lane) with append-only attempts and crash-safe reconciliation. Delivery is evidence, never a guess: an uncertain send is recovered from its job's receipts, not blindly re-fired."
---

# ADR 0190 — Notifications leave the app as durable work

**Status:** Accepted — implemented
**Date:** 2026-10-14
**Related:** [ADR-0042](./0042-unified-notification-center) (the canonical in-app center this extends, never replaces), [ADR-0025](./0025-connector-runtime) (the governed outbound queue the connector lane reuses), [ADR-0036](./0036-connector-inbox-writes) (the IM adapter contract)

## Context

The notification center (ADR-0042) is a good inbox: it records, coalesces,
snoozes, and respects per-source mutes and quiet hours. But it only ever
*showed* notifications. Getting a notification **out** — to Feishu, to a
webhook — was a thin side-channel: `im-deliver` resolved a conversation and
enqueued a message, then forgot it. Nothing knew whether the message sent, was
refused, or never left. There was no policy layer — no way to say "alert this
channel only on failures above `error`", no digest of a chatty run, no
do-not-disturb that applied to the wire rather than the toast.

Four defects fell out of that shape.

**A notification that failed was indistinguishable from one that sent.** Once
the outbound job was enqueued, the notification's story ended. If the job
dead-lettered, the user saw a green checkmark in the center and silence in
Feishu. There was no durable record connecting "the run finished" to "channel
X got message Y at time Z, status W".

**A crash could either lose a notification or send it twice.** The IM path
wasn't transactional with the run's own commit. A crash between the journal
append and the enqueue lost the notification entirely; a crash between the
send and any status write invited a blind re-send, because nothing recorded
that a send was already in flight.

**There was no place to say 'not yet' or 'not this one'.** Every event went
out immediately or not at all. Quiet hours that muted a toast didn't mute the
push; there was no digest for a run that emitted forty progress beats, no
inhibition while an incident was open, no "tell me again only if the result
actually changed".

**Every destination was hand-wired.** Adding a channel meant editing the
deliver path. There was no concept of a named, versioned, consented target
with its own disclosure ceiling — a webhook couldn't be told "you get `public`
summaries, never the confidential detail".

## Decision

Keep ADR-0042's center as the canonical inbox and put a **commit-first,
durable delivery pipeline** behind it. A notification that must leave the app
becomes a durable fact, a policy decision, and a set of delivery intents — all
persisted, all recoverable, all observable. Sending is a consequence of
durably recorded intent, never a side effect of an event handler.

### Facts and the commit-first touch

Producers no longer "send"; they commit. When the run journal appends an
event, the same IndexedDB transaction that writes the event also **touches a
durable `notificationProjectionWork` row** for that run (`runId` + desired
`seq`). No awaitable lookup may happen inside that transaction, so the scope
identity (`namespaceId` + `accountId`) is primed synchronously at
`activateAccountDatabase` — before any run write can need it — into a
dependency-free `identity-cache` module, and `authorityHostId` completes at
runtime boot via `primeNotificationScope`. This is the load-bearing
invariant: **the wake-up is durable before the producer returns**, so a crash
after commit cannot lose the notification.

A host-owned **coordinator** (`lib/notifications/delivery/coordinator.ts`)
claims each work row under a lease, reads the run's events since a persistent
cursor, and projects them into `DerivedNotificationFact`s — each with a stable
`logicalKey` (`run:{runId}:{slot}`) so replaying the same run is idempotent.
Every fact also reaches the existing center through `emit-center.ts` (which
reuses `notify()` and its routing/coalescing unchanged), so the inbox stays
the always-on record.

### Policy — a pure decision, then a durable commit

The planner (`lib/notifications/policy/planner.ts`) is a pure function over a
`PlannerFact`, the enabled subscriptions that bind the fact's scope/source/
run, and a `NotificationPolicyContext` (quiet hours, thresholds, timezone)
derived from the existing notification preferences. For each candidate route
it emits exactly one verdict — `notified`, `deferred`, `digest`,
`suppressed`, `pending-approval`, or a `denied`/`rejected` case — decided in a
fixed order (consent → disclosure ceiling → quiet hours → incident inhibition
→ explicit rules → quota). Quiet-hours defers with a `deferredUntil`; an
`aggregate` rule folds the fact into a named digest bucket instead of sending;
`suppress-if-unchanged` compares the fact's `contentHash` against accepted
prior intents (materiality) and suppresses the no-change repeat.

The decision is persisted (`notificationPolicyState`), then committed: each
`notified`/`deferred` route mints a **`NotificationDeliveryIntent`** — the
durable record of "perform this one external send to this one target".

### Two delivery lanes, one intent model

A connector target (a bound conversation) delivers through the existing
**governed outbound queue**: the intent and its `outboundQueue` job are
written in one transaction, the job carries `source: "notification"` and the
shared `notificationOperationKey`, and per-conversation `orderSeq` ordering is
preserved. A **feishu-webhook** target is one-way — it has no conversation —
so it gets a separate durable intent sender (`webhook-sender.ts` +
`feishu-webhook.ts`) that resolves the endpoint and signing secret from
credential-store refs **at send time only** (`{service}:{account}`), posts a
signed-or-unsigned Feishu payload with a 10s timeout, and classifies the
outcome (`accepted` / `rejected` / `rate-limited` / `auth-failed` /
`invalid-target` / `network-error` / `timeout-unknown`). The raw URL is never
persisted in the target, logged, or exported.

Every send appends to an append-only `notificationDeliveryAttempts` ledger.
An intent moves through `prepared → queued → sending → accepted`, or to a
terminal `rejected` / `failed` / `cancelled` / `expired`, or — deliberately —
to **`delivery-unknown`** when the outcome can't be established. Unknown is
sticky and never auto-retried, because a `timeout-unknown` send may already
have delivered.

### Reconciliation — recover from evidence, not re-send

A host-owned worker (`delivery/worker.ts`, installed into the connector
runtime's boot) runs on an interval and on wake hints, sweeping this account's
scope prefix in bounded batches. The **reconciler** re-claims expired
projection leases, folds terminal outbound-job statuses back onto their
intents (receipt drift), recovers stale `sending` claims **by projecting the
job's own evidence** — a `pending` job requeues the intent, a `sent` job marks
it accepted — and fires due timers (quiet-release re-queues a deferred intent;
digest-flush marks a bucket closed for the next pass). Errors are counted per
item and surfaced in the result, never thrown past the sweep. Nothing that
might already have sent is re-sent; the reconciler only ever moves an intent
to a state the evidence already supports.

### Targets, subscriptions, scope

A **`NotificationTarget`** is a versioned, consented destination — a
`connector` conversation or a `feishu-webhook` — carrying a label, a
disclosure-profile ceiling, a locale/timezone, and a `consent` grant
(`origin-reply` or `proactive`) recorded by the operator. Its semantic
fingerprint (`addressFingerprint`) identifies the destination independent of
credentials, so two aliases to the same place are one delivery slot and an
address change replans pending intents. A **`NotificationSubscription`**
binds a scope/source/run to a set of targets with a `minLevel`, a
`maxDisclosureProfileId`, and optional `rules` (deny / defer / aggregate /
suppress-if-unchanged) plus a per-fact intent quota. Both are CAS-versioned;
a stale version at commit time replans or rejects rather than sending to a
moved destination.

Everything hangs off **`NotificationScope`** — `{namespaceId, accountId,
workspaceId?, businessProjectId?, …}` — encoded as a stable `scopeKey` that
indexes every durable table and scopes every reconcile sweep.

### UI

Settings gains a **Delivery** panel (`notification-delivery-panel.tsx`) under
the existing notifications section: register a Feishu webhook by its
credential-store ref (never the URL), enable/disable/delete targets, and bind
subscriptions (scope / source / run + targets + min level + disclosure
ceiling). Notification items show a **delivery badge** aggregating each fact's
per-target outcome. A run's detail view gains a **Notifications tab** listing
every external delivery the run produced — target, purpose, status, time —
read live from the intent ledger.

## Consequences

- The in-app center is unchanged as the source of truth; external delivery is
  additive. A fact always lands in the inbox whether or not it leaves the app.
- External delivery is **evidence-shaped**: every hop is a durable row, so the
  answer to "did it send" is a lookup, and the answer to "why not" is a
  decision revision + attempt history, not a log guess.
- Crash recovery is the same shape as normal operation — the reconciler
  re-drives the same coordinator and the same intents — so there is no
  separate recovery code path to rot.
- Secrets stay out of the durable store; a webhook's URL lives only in the
  credential store and is resolved at send time.
- **Excluded:** Apprise/ntfy, new email/SMS providers, distributed automatic
  host takeover, and any change to the business execution state machine. No
  Kafka/Redis/Novu, no Next.js API routes — the pipeline runs entirely in the
  host's static-client + connector-runtime architecture.
