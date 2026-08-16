---
"cognia-next": minor
---

Add the issue tracker: an `/issues` board, `/projects` delivery containers, and a `/workspace` overview.

Issues are local-first and live in a new Dexie v170 set of tables, with printable per-project identifiers (`MERC-2`) allocated inside a transaction so two windows cannot collide on a number. The board is federated by design — local issues are the only writable source, and GitHub mirrors and agent tasks will project into the same board through read-only source adapters rather than becoming a competing third kanban.

Also generalises the connector label catalogue into a shared, scope-discriminated `labels` table (ids preserved, so existing conversation tags keep resolving) and fixes activity-trail ordering, which was non-deterministic whenever two events landed in the same millisecond.
