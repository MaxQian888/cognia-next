---
title: "0174: The Bot control plane"
description: "Six trigger kinds and four executors behind one durable delivery queue, a run that parks instead of blocking the host, a phone that can arm and replay without owning a runner, and one answer to where an inbound webhook should point on every host."
---

# ADR 0174: The Bot control plane

**Status:** Accepted
**Date:** 2026-09-07
**Amends:** ADR-0009 (platform connectors)
**Related:** ADR-0026 (plugin extension points), ADR-0027 (mobile sync), ADR-0045 (plan hub), ADR-0128 (scheduler host placement), ADR-0131 (IM delegation and relay), ADR-0137 (one delegation, one card), ADR-0155 (plugin author boundary)

## Context

Two things in this repository are called a bot, and they are not the same
thing.

The first is the IM connector, built over ADR-0009 and its successors. It is
mature: eleven platform adapters, one inbound pipeline, three admission gates,
and a five-valued routing decision that fans out to three execution targets.
Every reachable mode in it was already wired.

The second is `lib/bot/`, landed in five commits with no ADR and no changeset.
It is the general answer to "what kinds of task can run on their own": six
trigger kinds crossed with four executors, over a persistent step runtime that
memoises completed steps so a crashed host re-enters from the top without
redoing work. The runtime was good. The plane around it was not reachable from
anywhere, and it carried a defect that stranded work permanently.

## Decisions

### A Bot is a binding, not an engine

A Bot definition names an executor that already exists: a workflow, a squad, an
agent turn, or a plugin handler. It contributes no new way to run anything. The
value is in the binding, which is the pairing of "when" with "what", and in the
policy ceiling that pairing carries. This is why `installBot` writes a row
rather than registering a runtime.

### The delivery is the unit of fan-out, and it must never strand

`listDueBotDeliveries` treated `running` as not due and `running` as
unconditionally active on its concurrency key. A host that died mid-run left
that delivery permanently `running`: never retried, never dead-lettered, never
swept, and its `concurrencyKey` poisoned so every later delivery on that key was
skipped as `serialised`. A crash therefore took out a branch of work rather than
one run.

An expired lease now makes `running` due, exactly as it already did for
`leased`, and the claim records one recovery attempt through the shared
`decideNextAttempt`, so a delivery that can kill a host eventually dead-letters
instead of being re-claimed forever.

### Park, do not block

`waitForApproval` polled in place inside a serial drain loop, so one Bot waiting
on a human held up every other Bot on that host. A waiting run now parks: the
delivery moves to `parked` with a resume time, keeps its lease cleared, and does
not spend its retry budget on a person's thinking time.

`parked` is a new status rather than `pending` with a future `nextAttemptAt`.
Under `pending` the delivery would not count as active on its concurrency key,
so a second push on the same branch would start while the first was still
waiting, and the key would silently stop serialising anything.

### Automatic requeue, not `recovery_required`

The connector plane marks an interrupted unit `recovery_required` and waits for
a human, because its unit of work is a whole model turn with no memoisation, so
replaying it means sending it again. The Bot plane is the opposite: the run id
is derived from the delivery id, steps are memoised, and approval interrupt ids
are derived too. Re-entry is the documented contract, so an interrupted delivery
is requeued and the attempt is counted.

### `interaction` makes a Bot an observer, not a routing target

An IM conversation can bind to a direct agent, a team, or a workflow. It cannot
bind to a Bot, and `ImTargetKind` deliberately gained no `bot` value.

A Bot observes the inbound stream in the same position a workflow trigger does,
after the sibling-bot loop guard has had its say. Putting it earlier would let a
message the guard just rejected drive a Bot loop, and spend the interaction
budget on a path the guard had already closed. Putting it in the routing
decision would make it compete for a conversation that already has an answer.

### The mirror fence lives at the queue's throat

`botRunId` is derived deterministically from the delivery id, and `executionRuns`
already syncs. So the moment `botEventDeliveries` crossed the companion plane, a
second host draining a mirrored delivery would mint an `ExecutionRun` with the
same id as the original host's, and the two would write over each other in one
shared table.

Mirrored rows carry `syncedFromHost: true` and are excluded inside
`listDueBotDeliveries`, which is the single chokepoint `drainBotDeliveries`,
`claimBotDelivery` and `countActiveBotDeliveriesForKey` all flow through. A
fence in the runner would have missed two of the three.

`BotInstallationRow` carries the same flag for a different reason: without it,
`syncBotTriggerSchedules` would turn another host's armed cron into a local
scheduler task, and both hosts would fire.

### `botRunSteps` never crosses

Two reasons, and either alone would be enough. Its `output` is stored verbatim,
deliberately, because redacting it would corrupt the handler that resumes from
it, and verbatim output is exactly what every projection strips. Structurally,
its primary key IS the memoisation key, so a companion that mirrored it would
read another host's notes as its own.

### Availability is two questions, not one

`resolveBotWriteRoute` is three-way and per-command, because arming a trigger
only needs the database while running and replaying need a live runner.
`resolveBotLifecycleWriteAvailability` is binary, because install, configure,
bind and uninstall have no remote leg at all.

Both begin by asking whether a remote host is active, before asking about local
capability. `always-on` is a static baseline that a desktop driving a remote
Cognia still reports while its own runtimes are torn down, so checking
capability first would route a write into a process that has nothing to execute
it.

### The idempotency key encodes what a replay must do

Arming uses a key naming the VALUE it sets, `bot-arm:<inst>:<trigger>:<0|1>`, so
arm, disarm and arm again are three distinct rows and replaying the first still
leaves the host armed. A toggle command could not be made safe at any key, which
is why the write is absolute rather than relative.

A manual run mints a fresh key per press, because two presses ARE two runs and
only a fresh key distinguishes that from a retry of one. A replay derives its
key and the host arm additionally requires the row to still be dead-lettered, so
a duplicate finds nothing to do.

### A plugin describes its webhook verification, it does not implement it

`verify_webhook` had hand-written arms for four platforms and refused everything
else, so a plugin connector declaring the `webhook` transport had a public
endpoint that answered nothing.

The scheme is now declared in the manifest and executed by Rust. A callback into
plugin code was rejected for three reasons, the last decisive: there is no
host-to-plugin request primitive to call through, the platforms that matter
demand a handshake answer within about three seconds, and a callback would hand
an unauthenticated public request body to plugin code before anything
established where it came from.

`secretKey` names a keyring entry, never an inline secret, because a manifest is
world-readable inside the install directory. A basestring must cover the body: a
signature over anything less authenticates the sender of some request rather
than this one.

### The ingress shape follows the host profile

Six adapter forms and the Tunnel tab each derived the public callback URL
themselves, and all of them assumed the cloudflared tunnel. A cloud install has
no tunnel and needs none, so it was shown advice for a different host while the
address that works, `https://host/connectors/webhook/<type>/<id>`, appeared
nowhere in the product.

One hook now answers it, keyed on the host profile rather than on `isTauri()` or
on connector reach, which is a different question that reads true on a headless
host. A phone reads only its paired host's tunnel origin: it also knows a LAN
base, but that is a private address and offering it for a platform console
advertises something the platform can never reach.

The empty states stay separate. A missing tunnel, a missing cloud origin and a
browser with no host behind it have three different remedies, and collapsing
them is how the cloud case came to be shown the desktop's.

### The declared transport outranks the row

`adapterNeedsInboundServer` read `row.transportMode` and demanded an exact match
for webhook while defending itself on the reverse-WebSocket branch. Lark, Slack
and Telegram declare a single transport computed from `settings.transport`,
which is an independent persisted field with no migration and no invariant tying
the two together, and WeChat OA speaks webhook and nothing else. Either way, a
row that failed the exact match started no receiver, and an adapter with no
receiver reports healthy and answers nothing.

The adapter's declared `transportModes` now decides whenever it names exactly
one, and the row only disambiguates a genuinely dual-mode adapter.

## Known limitations

These are recorded here rather than left for the next person to discover.

1. **A companion cannot answer a Bot approval.** `executionRunInterrupts` is not
   in `COMPANION_SYNC_PROTOCOL_TABLE_NAMES` and has no reference anywhere in
   `lib/sync/` or `companion_api/`. The only surface that renders a
   `bot_approval` interrupt is the desktop attention panel. A phone can arm a
   trigger, start a run and replay a dead letter, and cannot approve.
2. **`botEventDeliveries` has no `updatedAt` index.** Every other status-projected
   table has one. Adding it would reset every existing database, which a mirror
   does not justify, so the cross-device read is a bounded window scan on
   `receivedAt` filtered in memory. It is the most expensive read in the sync
   set.
3. **`bots:read` and `bots:execute` are still only a doc comment.** They appear
   once in `types/plugin/plugin.ts` and nowhere else in the tree, so
   `bot_run_manual` reuses `workspace.write` as its capability. Making them real
   is its own change, with its own vocabulary gate.
4. **WeCom and DingTalk have an unbuilt second transport.** Both platforms
   publish an HTTP callback and only their gateway path is implemented here.
   `SINGLE_TRANSPORT_PLATFORMS` records this as `unbuilt` rather than as a
   platform limitation, because it is a backlog item with a known path and
   WeCom's scheme is already implemented for WeChat OA.

## Consequences

The Bot plane is reachable: `/bots` installs, configures, binds credentials,
arms triggers, runs on demand, replays dead letters, and shows run history
through the cockpit that already had it. A paired device sees the same list and
can drive the three controls that do not need a local runner.

A crash no longer strands a branch of work, and a run waiting on a human no
longer holds up the host.

`plugins/cognia-scheduler-tools` contributes the first Bot, which is what makes
the plugin path a tested path rather than a bridge with no consumers.

On the connector side, a cloud install can be told where its own callbacks live,
a plugin connector can receive over webhook, and an adapter whose two transport
fields disagree no longer sits silently down.
