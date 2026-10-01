---
title: "0207 — A collaboration event reaches people who are not in the room"
description: "The collaboration server writes one notification row per recipient when something is addressed to a person: an assignment, a declared mention in an issue comment, an approval request, or an invitation. Rows are RLS-scoped, deduplicated and carry read state. They reach a client over the ADR-0206 feed, and a cursor pull catches up. The client hands each one to the existing ADR-0042 notify() pipe as source \"collab\", so channel preferences, quiet hours, OS toasts, mobile push and IM delivery all come from what already exists. Reading one on any device clears it on the others."
---

# ADR 0207 — A collaboration event reaches people who are not in the room

**Status:** Accepted, implemented (2026-10-01)
**Date:** 2026-09-30
**Related:** [ADR-0042](./0042-unified-notification-center) (the notify pipe), [ADR-0149](./0149-a-person-is-not-a-device) (which left this as "a second-cut question"), [ADR-0206](./0206-a-workspace-streams-its-changes-instead-of-being-polled) (the feed this rides), [ADR-0177](./0177-a-room-is-one-conversation-shape) (human mentions in shared chat, still "Later")
**Source study:** `docs/plans/2026-09-30-collaboration-multi-device-gap-analysis.md` (gap A3)

## Context

The collaboration plane lets people do things to each other:

- assign a shared issue (`validate_human_assignee`, `api.rs`);
- ask for an approval in a shared chat (`chat_approval_requests`);
- invite someone to a shared session (`chat_session_invites`).

None of these tells the person concerned. The only signals are the chat
stream's broadcast and the next mirror refresh, and both reach only someone
who already has the room or board open. An approval request that is waiting
on a teammate who is away waits until they happen to look.

ADR-0149 deferred this on purpose. Notifications stayed local, and delivering
collaboration notifications was "a second-cut question". The local side has
since become complete. `notify()` (ADR-0042, `lib/notifications/notify.ts`)
already:

- deduplicates and coalesces;
- applies per-source and per-project preferences, DND and quiet hours;
- routes to the center, a toast, the OS, mobile push through the paired Host
  (`lib/notifications/inbound-push.ts`, `device-channel-gate.ts`), and IM
  (`lib/notifications/im-deliver.ts`).

The missing piece is on the server: a durable record of who something was
addressed to. Linear's Inbox, GitHub notifications and Slack all make the
same split. The server owns the per-recipient row and its read state; each
device decides how to surface it.

## Decision

### 1. The server writes one row per recipient

Migration `0013_notifications.sql` adds `collab_notifications`:

| column | notes |
| --- | --- |
| `id` | `ntf_…` |
| `org_id`, `recipient_user_id` | RLS on `app.tenant_id`; a reader sees only rows addressed to them |
| `workspace_id` | nullable; used for the access check on read |
| `kind` | `issue.assigned`, `issue.mentioned`, `chat.approval_requested`, `chat.invited` |
| `subject` | `{entity, id}` of the thing to open: an `issue`, a `chat_session`, or a `chat_invite` |
| `actor_user_id` | who caused it |
| `dedupe_key` | unique per `(recipient, dedupe_key)`, e.g. `issue.assigned:iss_…:rev7` |
| `seq` | per-recipient monotonic, the pull cursor |
| `created_at`, `read_at` | `read_at` null until read on any device |

The handler that made the write records the rows after the store commits,
the same rule the ADR-0206 feed follows. A notification is a consequence of
the write, not part of it. The assignment stands even if telling the assignee
fails; that failure is logged instead of turning a successful write into a
500. The dedupe key is derived from the write
(`issue.assigned:<id>:rev<n>`, `issue.mentioned:<event id>`,
`chat.approval_requested:<approval id>`, `chat.invited:<invite id>`). A retried
write that replays the same revision or event therefore records nothing twice.

`seq` comes from a per-recipient cursor row (`collab_notification_cursors`),
which is locked for the insert. A recipient's rows therefore commit in `seq`
order, and a client paging `afterSeq` never skips a row that committed late.

The actor is never notified about their own act. A recipient who cannot read
the subject's workspace at write time gets no row. The check uses
`resolve_workspace_access` again, because notifying someone about something
they are not allowed to open leaks both its existence and its title.

Rows carry references, not content. The title the client displays is resolved
from its own mirror, or from a single `GET` on the subject if the mirror has
not caught up yet.

### 2. Mentions are declared, not parsed

Issue comments (`append_event`) gain an optional `mentions: usr_[]` in their
payload. The server validates each id against workspace membership, and an
unknown id is a 400, not a silent drop. The comment composer's person picker
fills the field. Free text containing `@name` is never parsed on the server:
display names are not unique, and guessing wrong notifies the wrong person.

Human mentions in shared chat stay under ADR-0177's "Later". Once that lands,
it produces `chat.mentioned` rows through this same table.

### 3. Delivery: the feed when connected, a cursor pull otherwise

- `GET /v1/orgs/{org_id}/notifications?afterSeq=&limit=&readAt=&readSeq=`
  lists the caller's rows after `afterSeq`, and never anyone else's. A row
  whose workspace the caller can no longer read is withheld, but
  `nextAfterSeq` still moves past it. The same response carries `reads`: rows
  marked read since the `(readAt, readSeq)` cursor. That is how a read on one
  device reaches the others. The cursor is a pair because a single "mark all
  read" stamps many rows with the same instant.
- `POST /v1/orgs/{org_id}/notifications/read` takes `{ids}` (up to 500) or
  `{upToSeq}`, never both, and marks the caller's unread rows read. It is
  idempotent.
- The ADR-0206 feed's per-user frame, `{kind: "notification", seq}`, goes only
  to that user's sockets. It is sent when a row is created, and again when
  the user marks rows read. The frame carries no content; the client pulls.

Only a high-risk approval request notifies anyone. An ordinary request can be
resolved only by its own requester (`resolve_approval`), so nobody else is
asked. A high-risk request reaches every session member whom
`authorize_session_action` lets approve high risk, except the requester.

A `chat.invited` row is only sent for an invite that names its target. Such an
invite can now be accepted by its target with
`POST /v1/orgs/{org_id}/chat-invites/{invite_id}/accept`, without the token: the
invite already says who may join, and the signed-in caller proves who they
are. Anyone else gets the same answer as for a used invite. Without this route,
the notification would point at something its recipient could not act on.
Org invitations are not notified at all. They are untargeted bearer tokens,
so there is nobody to address until someone redeems one.

A new `lib/collab/notifications-sync.ts` keeps its cursor in `localStorage`, as
`lib/collab/connection.ts` already does for per-account collaboration state.
The cursor is `{afterSeq, readAt, readSeq}` plus the ids of local reads not yet
posted, keyed by local account, server and org. It pulls on:

- a feed frame, and every feed (re)connect, since frames sent while the socket
  was down reached nobody;
- boot, focus, coming online and becoming visible, the same triggers as the
  mirror refresh.

### 4. The client hands each row to the pipe that already exists

Each new row becomes one `notify()` call:

- `source: "collab"`, a new member of `NotificationSource`, so a person can
  mute or re-route it per source in Settings → Notifications;
- `dedupeKey`: the row's `dedupe_key`. The local `seq` cursor is the first guard
  against a replayed pull, because rows at or below it are never handed over.
  The dedupe key is the second: a second tab that races the cursor bumps the
  existing record (`lib/notifications/dedup.ts`) and does not create another;
- `sourceRef: {kind: "collab-notification", id}` and an action that opens the
  subject: the issue deep link, or the shared session;
- `directed: true` for every kind. Each one is addressed to this person, so it
  counts toward the red numeric badge rather than the ambient dot;
- `level`: `warning` for approval requests, since a run is blocked on them, and
  `info` for the rest.

No new UI pipeline, no new push path and no new IM path. The person's
existing preferences decide whether the item reaches the center, the OS, the
phone or Feishu.

Marking a notification read in the local center posts `read` to the server.
The read clears it on that person's other devices at their next pull, which
the feed triggers at once. When the local center already shows the item as
read, a server `read_at` is not re-toasted.

### 5. Retention

Read rows are pruned after 90 days and every row after 180. Pruning is lazy
and per recipient: writing a recipient's next row deletes their expired ones
in the same transaction. A background sweep was rejected. The tables run
under FORCE row-level security, so a sweep would need either a privileged role
that bypasses RLS or a loop over every tenant. A recipient who stops
receiving anything keeps at most 180 days of rows. Pruning never reuses a
`seq`. A pruned row is gone everywhere. A device that
never saw it before the prune shows nothing, which is the right answer six
months on.

## Consequences

- An assignee, a mentioned teammate or an approver hears about it on the
  channels they already chose, including the phone and IM, without having the
  room open.
- `NotificationSource` gains `"collab"`. That needs `en` and `zh-CN` label keys
  under the notifications settings split sources, plus a per-source default.
- The server gains its first per-person state that is not membership. The
  Postgres RLS test (`tests/postgres_rls.rs`) must prove that one user cannot
  list or mark another user's rows. It already runs in CI: the `postgres-rls`
  job in `.github/workflows/test.yml` runs the ignored tests against a
  Postgres service whenever `crates/cognia-collab-server/` changes.
- New tests:
  - migration and store tests for per-recipient uniqueness and seq
    monotonicity;
  - handler tests for no self-notification and no notification without access;
  - `lib/collab/notifications-sync.test.ts` covering replay dedupe and read
    propagation;
  - an update to the `NotificationSource` exhaustiveness tests.

## Not decided

- **Email.** It needs an outbound mail provider and a per-person address
  policy. Not proposed.
- **A hosted push relay.** Push still goes through the person's own paired Host
  and its APNs/FCM credentials. A person with no paired Host and no open app
  sees the notification at next open. A relay is roadmap item P2-13 in the
  source study.
- **Digesting.** Coalescing many rows into "5 updates on X" is left to the local
  `notify()` coalescing, which already exists. A server-side digest is not
  proposed.

## Implementation notes (2026-10-01)

- Server:
  - `crates/cognia-collab-server/src/notifications.rs` holds the store trait,
    the in-memory and Postgres stores, `deliver` and the routes.
  - Migration `0013_notifications.sql` adds the rows and the per-recipient
    cursor table, both under tenant RLS.
  - The producers live in `create_issue` and `patch_issue` (only when the
    assignee changes hands), `append_event` (`payload.mentions`),
    `create_approval` (high risk only) and `create_invite` (named invites only).
  - `accept_targeted_invite` is the new by-id acceptance.
  - The Postgres tests `notifications_are_per_recipient_ordered_and_deduplicated_in_postgres`
    and `a_targeted_invite_is_accepted_by_its_target_alone_in_postgres` run in
    the `postgres-rls` job.
- Client:
  - `lib/collab/notifications-sync.ts` is mounted with the feed in
    `issue-tracker-initializer.tsx`.
  - The first pull for an account and org (no cursor yet) brings the unread
    backlog into the center only (`channels: ["center"]`): no toast, OS
    notification, push or IM. A row already read when first seen is not
    imported.
  - Server reads mark the local record (`logicalKey: collab-notification:<id>`)
    and are never posted back. Local reads, including mark-all and archive, are
    queued and posted in batches; a failed post retries on the next pull.
- Links:
  - An issue opens `/issues?id=<id>&source=collab`. The issues page now honours
    `source`, because collab and local issue ids share the `iss_` prefix.
  - An approval request opens `/?session=<local id>`. The root page now consumes
    session-only links (`hooks/chat/use-session-link.ts`); before this, every
    `buildSessionHref` link opened nothing.
  - An invitation opens `/?acceptInvite=<id>&org=<org>`. That asks before
    accepting and then opens the conversation.
- Mentions: the comment composer has a teammate picker
  (`hooks/collab/use-collab-mention-candidates.ts`, the live workspace roster).
  It sends only the ids whose `@Name` is still in the text.
- Push: the companion push allow-list in
  `crates/cognia-companion-rpc/src/command_services.rs` was missing the
  `issue`, `site` and `collab` sources, so their phone push was refused
  silently. All three are allowed now.
