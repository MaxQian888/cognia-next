# Collaboration, artifact persistence, and sharing hardening

Date: 2026-09-21

## Reference assessment

The reference documents are `run-collaboration-multi-user-public.md` and
`run-plugins-artifacts-persistence-sharing-public.md`. They describe another
product's mechanisms; they are not instructions or Cognia's product contract.

| Reference strategy                                              | Cognia decision                                                                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorize on the server and recheck before dispatch             | Reuse the shared-session policy engine and store transaction. Check the queue requester and executor, including requests admitted before a membership change.                    |
| Same idempotency key means the same operation                   | Compare stable actor, event kind, and semantic payload. Exact retries preserve their original result and context boundary; conflicting retries return a conflict.                |
| Revocation cleans queued work and credentials                   | Cancel queued requests and invalidate live leases when execution permission is lost. Preserve terminal history and existing explicit executor takeover rules.                    |
| Multi-user tasks default to public read                         | Do not adopt. Cognia's explicit private session membership and encrypted snapshot shares remain separate contracts.                                                              |
| Agent messages execute as the creator                           | Do not adopt. Preserve Cognia's designated executor and lease authority; sending a message does not confer another person's credentials.                                         |
| Automatically add collaborators to a workspace                  | Do not adopt. Workspace access and private-session membership remain separate authorization boundaries.                                                                          |
| Write checkpoint content before advancing its committed pointer | Apply to the existing Dexie bridge: serialize writes, compute differences from the last committed state, and advance the mirror only after a successful transaction.             |
| Keep artifact mirrors separate from recovery authority          | Preserve Dexie as the artifact/version authority and localStorage migration data as a scoped recovery copy. Public encrypted shares are snapshots, not recovery input.           |
| Live preview with object-store fallback                         | Retain Cognia's existing preview/export paths. Container ports, Linux identities, and object-store namespaces from the reference do not map directly to the local-first runtime. |
| Public access grants reads only                                 | Preserve separate share owner credentials for renewal, stats, and revocation; never promote a public URL or decryption key into management authority.                            |

## Existing boundaries extended

- `crates/cognia-collab-server/src/chat_store.rs`: shared policy checks,
  semantic replay validation, and membership/queue/lease consistency in both
  PostgreSQL and the in-memory implementation. Queue claims persist their
  source item: retries cannot reuse one operation to claim another input.
- `crates/cognia-collab-server/src/chat_api.rs`: bounded, expiring socket and
  attachment credentials; closed sockets release their subscriptions; lagged
  streams reconnect through the existing durable cursor catch-up.
- `lib/collab/shared-session-access.ts` and `lib/share/chat-export.ts`: shared
  exports require current server authorization, including cached multi-chat
  previews before publication. The existing permission engine decides access;
  batched checks cap concurrent authorization requests at eight.
- `lib/artifacts/dexie-bridge.ts` and `localstorage-migration.ts`: reuse the
  existing artifact store and provider, with account-scoped recovery,
  lifecycle-bound hydration, serialized/coalesced writes, and retry backoff.
  An account restart waits for its own final write; another account is not
  blocked by that transaction. Uncommitted recovery is in memory and cannot
  survive process termination while IndexedDB remains unavailable.
- `lib/share/client.ts` and `renew.ts`: one owner-request resolver binds old
  links to their original service. A newly configured server's upload secret
  is never forwarded to the old service. Legacy links without an owner token
  require matching service configuration rather than falsely reporting revocation.
- `services/share-server`: extend the existing share API and storage instead
  of introducing a second sharing surface. Renewal preserves content and view
  counts and must not revive expired, revoked, burned, or exhausted shares.
  The Worker reuses its handlers behind one Durable Object per share. That
  object serializes reads, renewals, revocation and expiry across isolates;
  persistent tombstones and cleanup alarms prevent stale KV resurrection.

Unscoped migration recovery copies have no reliable account attribution. They
are retained, not automatically imported into whichever account happens to be
active. Newly captured recovery data has an explicit account scope.

## Rollout requirements

`0011_chat_run_queue_binding.sql` is registered in `PgStore::migrate`. Historical
leases keep an unknown queue association and reject queue-claim replay rather
than guessing. The migration has not been applied to a live PostgreSQL server.

The Worker requires the `SHARE_LIFECYCLE` binding and SQLite Durable Object
migration included in both default and staging Wrangler configurations. Legacy
KV metadata is imported on first access; R2 ciphertext stays in place. Missing
authority returns 503. Avoid mixed traffic with the previous KV-writing Worker
and do not roll back to that version. Organization listing still uses KV for
discovery and can lag, but each returned share is checked against its authority.
See `services/share-server/README.md` for the deployment details. No deployment
or production migration was performed.

## Verification boundary

Regression checks cover account switches during hydration, concurrent artifact
updates/deletes, semantic retry conflicts, loss of posting permission, socket
closure, original-endpoint share ownership, and renewal lifecycle handling.
The combined targeted frontend run passed 137 tests in eight suites; scoped
ESLint passed. Collaboration checks passed 19 store tests and 14 API tests.
Worker validation passed 57 tests, including local Durable Object concurrency,
interrupted creation and cleanup recovery regressions. Worker TypeScript checks
and production/staging Wrangler dry-runs passed. The Rust share service passed
seven focused renewal regressions and scoped Clippy checks.

The user explicitly requested skipping coverage and repository-wide green
gates. The initial coverage run encountered unrelated failures and was stopped;
it is not evidence of repository-wide coverage or passing status. Focused local
checks do not establish live PostgreSQL, deployed Cloudflare, public-network,
or real multi-device acceptance. No deployment is performed by this change.
