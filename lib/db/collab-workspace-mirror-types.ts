/**
 * Row type for the collaboration-plane workspace mirror — Dexie
 * `collabWorkspaces`.
 *
 * Split from the CRUD module for the same reason
 * `collab-issue-mirror-types.ts` is: `lib/db/schema.ts` needs the type to
 * declare the table, and importing the CRUD module there would make the schema
 * depend on its own accessors.
 */

/**
 * One workspace as the collaboration server last reported it.
 *
 * Deliberately thin, matching what the server sends: roots, trust and
 * provisioning stay local (ADR-0144 / ADR-0147) because they describe one
 * machine's relationship to a checkout. What travels is the name — the thing a
 * person invited into somebody else's workspace has no other way to learn,
 * since they hold no local `projects` row for it.
 */
export interface CollabWorkspaceMirrorRow {
  /** The workspace id, which is the local `projectId` (ADR-0149 §1). */
  id: string
  orgId: string
  name: string
  createdAt: number
  updatedAt: number
  /** When this client last heard it. Drives the stale badge, never a decision. */
  fetchedAt: number
}
