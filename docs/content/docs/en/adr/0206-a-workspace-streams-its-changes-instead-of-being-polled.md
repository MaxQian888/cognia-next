---
title: "0206 — A workspace streams its changes instead of being polled"
description: "The collaboration plane gains one change feed per organisation. It is a WebSocket carrying invalidations only ({entity, id, workspaceId, revision}), and each frame is filtered by the reader's workspace access. The mirror keeps its single refresh path; the feed only tells it which legs to run and when. The 60-second poll stays as the degraded fallback. The single-use ticket and per-key broadcast that shared chat and Canvas each copied become one SocketHub, which all three streams share."
---

# ADR 0206 — A workspace streams its changes instead of being polled

**Status:** Accepted, implemented (2026-09-30)
**Date:** 2026-09-30
**Related:** [ADR-0149](./0149-a-person-is-not-a-device) (the collaboration plane), [ADR-0158](./0158-artifacts-and-canvas) (the Canvas stream), [ADR-0207](./0207-a-collaboration-event-reaches-people-who-are-not-in-the-room) (which rides this feed), [ADR-0208](./0208-edits-to-different-fields-merge)
**Source study:** `docs/plans/2026-09-30-collaboration-multi-device-gap-analysis.md` (gap A2)

## Context

Shared issues, plans, runs, workspaces and memberships reach a client through
one path: `refreshCollabPlane` (`lib/collab/refresh.ts`). It pulls four legs in
order (memberships, workspaces, issues, then plans and runs), writes the
rebuildable Dexie mirrors, and leaves them untouched when a pull fails.
`installCollabRefreshScheduler` (`lib/collab/refresh-scheduler.ts`) decides
when that runs:

- on boot, focus, coming online and becoming visible;
- every `COLLAB_REFRESH_INTERVAL_MS = 60_000` while the window is visible;
- with backoff up to 15 minutes after failures.

So when a teammate moves a card, you find out up to a minute later, and only
if your window is in front. Every idle client also re-pulls every list once a
minute. Linear, Figma and Notion all avoid both problems the same way: the
server pushes one workspace-level feed, and the client reacts to it.

The server already knows how to push. Shared chat (`chat_api.rs`) and Canvas
(`canvas_api.rs`) each carry their own copy of the same machinery:

- a map of single-use tickets that expire in 30 seconds, with sweeping;
- a `RwLock<HashMap<key, broadcast::Sender<Frame>>>`;
- a stream loop that ends on `RecvError::Lagged` or `Closed`.

The tests for the two copies assert the same properties. Issues and plans
have no such stream.

## Decision

### 1. One hub, three streams

`crates/cognia-collab-server/src/socket_hub.rs` owns `SocketHub<K, F>`. It
covers ticket issue, consume and sweep, per-key broadcast, and per-user
ticket revocation, which chat already needs for offboarding. Chat and Canvas
move onto it as a refactor with no behaviour change. Their existing tests keep
passing, and the hub gets its own tests for:

- tickets are single-use;
- expired tickets are swept;
- a revoked user loses every ticket they hold;
- a lagged receiver is told so rather than silently skipped.

### 2. The feed carries invalidations, not data

- `POST /v1/orgs/{org_id}/feed/tickets` mints a ticket. It requires org
  membership and is scoped to the caller's `usr_`.
- `GET /v1/orgs/{org_id}/feed?ticket=` upgrades to a WebSocket.

Frames carry no data, only invalidations:

```json
{ "kind": "invalidate", "entity": "issue", "id": "iss_…", "workspaceId": "ws_…", "revision": 7 }
```

- `entity` is one of `issue | issue_event | plan | run | workspace | membership`.
- A membership frame names the affected `usr_` rather than a revision.

The client does not apply frames. It asks the mirror to refresh the leg the
entity belongs to. That keeps **one** write path into the mirrors, the one
`lib/collab/sync.ts` already guarantees: a failed pull leaves the mirror as it
was, and nothing is ever rewritten optimistically. A frame that arrives while a
refresh is running marks that leg dirty for one more pass, and does not queue a
second concurrent pull.

Frames are published after the store commits, by the handler that made the
write: `create_issue`, `patch_issue`, `append_event`, the plan and run
handlers, and the membership-admin handlers. Publishing before commit could
announce a revision that a rolled-back transaction never made.

### 3. Access is checked for every frame

A frame goes to a socket only if that socket's user can read `workspaceId`,
decided by `resolve_workspace_access` in `cognia-tenant-auth`. The result is
memoised per socket per workspace for 5 seconds. A membership frame naming the
socket's own user clears the memo at once. Removing someone from a workspace
therefore stops their feed on the next frame, the same guarantee Canvas makes
for writes (ADR-0158).

Frames for workspaces the reader cannot see are dropped, not redacted. Even an
id leaks existence, and a caller with no access gets 404 everywhere else.

### 4. The client: the feed drives the scheduler, and polling degrades

A new `lib/collab/feed.ts` opens the socket through the same transport
`CollabClient` uses: the platform fetch, proxy-aware on desktop, with a fresh
ticket for every connection attempt. While the feed is connected:

- `installCollabRefreshScheduler` stops its 60 s interval;
- it still refreshes on boot, focus and online, which catches anything missed
  while the socket was down;
- frames are coalesced for 250 ms per leg, then drive `requestCollabRefresh`
  with a leg filter. `refreshCollabPlane` gains an optional
  `legs: CollabRefreshLeg[]`, and its default is still every leg;
- `Lagged`, or any close other than a normal one, means a full refresh, then a
  reconnect with the scheduler's existing backoff.

While the feed is down, the 60 s poll resumes unchanged. The stale badge
(`components/issues/collab-refresh-stale-badge.tsx`) keeps reading
`lastSuccessAt`, so it stays accurate whichever of the two is running.

### 5. Rollout

- Server: behind `COLLAB_FEED_ENABLED`, which defaults to **on**. The feed only
  makes an existing read fresher; it grants nothing new.
- Client: the feed falls back on its own. A server without the route answers
  404 on the ticket mint, and the client keeps polling and does not retry the
  mint until the next boot.

## Consequences

- A teammate's change reaches an open client in well under a second instead of
  up to 60 s. An idle client stops re-pulling every list once a minute.
- Chat, Canvas and the feed share one ticket and broadcast implementation, so
  a fix to ticket expiry or revocation lands once.
- [ADR-0207](./0207-a-collaboration-event-reaches-people-who-are-not-in-the-room)
  can deliver a per-user notification frame over the same socket without a
  fourth stream.
- `tokio::broadcast` is process-local. Like chat and Canvas today, the feed
  assumes one collab-server instance per organisation. See "Not decided".
- New tests:
  - `socket_hub.rs` in-file tests;
  - `feed.rs` tests for per-frame access and memo invalidation;
  - `lib/collab/feed.test.ts`;
  - an update to `refresh-scheduler.test.ts` for the feed and poll handover.

## Not decided

- **Delta payloads.** Frames could carry the changed row, letting the client
  skip the pull. That needs a second write path into the mirrors, and today's
  guarantees rest on there being one. Revisit if a large organisation's
  per-leg pulls become the bottleneck. A `since` cursor on the list routes is
  the cheaper step first.
- **More than one server instance.** Fanning out across instances needs
  Postgres `LISTEN/NOTIFY` or an external bus. It would apply to chat and
  Canvas as much as to the feed, so it belongs to whichever ADR first needs
  horizontal scale.
- **A feed for a paired phone.** A phone using the collaboration plane talks to
  the server directly, as the desktop does. Relaying the feed through the
  companion Host is not proposed.

## Implementation notes (2026-09-30)

- The feed is one stream per **organisation** (`/v1/orgs/{org}/feed`), not per
  workspace: a person in several workspaces holds one socket, and per-frame
  scope filtering does the rest.
- `socket_hub.rs` (`TicketBook`, `Channels`) now backs shared chat, Canvas and
  the feed. Canvas tickets gained the capacity bound chat already had
  (`429` past 8,192 pending).
- Handlers publish after the store returns: issues, issue events (named by
  their issue), plans, runs, and every membership write. A refused write
  publishes nothing (`api.rs` test
  `a_committed_patch_is_announced_on_the_feed_and_a_refused_one_is_not`).
- Client: `lib/collab/feed.ts`, mounted by
  `components/providers/initializers/issue-tracker-initializer.tsx` and rebound
  when the server URL changes. `refreshCollabPlane` takes `legs`; identity and
  the reader's own memberships always run. The headless brain keeps polling
  (`lib/headless/runtimes/collab-refresh.ts`).
- Notification frames are filtered to their recipient. Since ADR-0207 they are
  published whenever a row is written for that person or they mark rows read.
  The client answers each frame with a notification pull, not a mirror
  refresh.
