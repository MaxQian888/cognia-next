/**
 * Replacing a derived `usr_…` with the canonical one the server assigned.
 *
 * # Why two ids ever exist
 *
 * Before a collaboration server existed, the first sign-in derived a user id
 * from the Logto issuer and subject so every machine would agree without
 * anyone to ask (`lib/identity/sign-in.ts`). The server, when it arrives,
 * assigns its own `usr_…` on bootstrap or invitation acceptance and is the
 * authority for it. A profile bound before that moment therefore holds a
 * derived id in its binding, its projection rows, its issue assignments and
 * its collaboration mirrors, while everything the server sends names the
 * canonical one. Left alone, "assigned to me" is false for the person it is
 * assigned to.
 *
 * # What is rekeyed, and what is not
 *
 * Rekeyed: the profile binding, the `users` / `orgMemberships` /
 * `workspaceMemberships` / `externalIdentities` projection, human issue
 * assignees and human issue creators, and the human actors on the
 * collaboration mirrors. Every one of those columns is proven to hold a
 * `User` id by its type.
 *
 * Not rekeyed: issue events (append-only history), and any author-shaped
 * field whose domain is not proven to be `User` (message authors, session
 * owners). Rewriting an id in a column that might hold something else is how
 * a migration corrupts data it was never asked about.
 *
 * The derived id is kept on the binding as a legacy alias, so a row that
 * still carries it can be recognised later rather than read as a stranger.
 */

import { UserBindingRegistry } from "./user-binding"
import { bindHostPerson, type HostPersonDeps } from "./host-person"

import { getDb } from "@/lib/db/schema"
import { orgMembershipId, workspaceMembershipId, type User } from "@/types/identity"
import type { CollabIssueActor } from "@/types/issues/collab"

export interface ReconcileUserIdInput {
  localAccountId: string
  legacyUserId: string
  canonicalUserId: string
  /** Re-mirror the person to the host with this token, when there is a host. */
  accessToken?: string
  orgId?: string
  now?: number
}

export interface ReconcileUserIdDeps {
  registry?: Pick<UserBindingRegistry, "get" | "reconcileUserId">
  host?: HostPersonDeps
  onHostMirrorFailed?: (error: unknown) => void
}

export interface ReconcileUserIdReport {
  /** False when the ids were already the same. Nothing was touched. */
  changed: boolean
  users: number
  orgMemberships: number
  workspaceMemberships: number
  externalIdentities: number
  issueAssignees: number
  issueCreators: number
  collabIssues: number
  collabPlans: number
  collabRuns: number
  /** Whether the host was told. False off the desktop or without a token. */
  hostRebound: boolean
}

function isHuman(actor: CollabIssueActor | undefined, id: string): boolean {
  return actor?.kind === "human" && actor.id === id
}

function rekeyActor(actor: CollabIssueActor): CollabIssueActor {
  return { ...actor }
}

/**
 * Rewrite every proven `User` column from `legacyUserId` to `canonicalUserId`,
 * then move the profile binding and the host over.
 */
export async function reconcileUserId(
  input: ReconcileUserIdInput,
  deps: ReconcileUserIdDeps = {}
): Promise<ReconcileUserIdReport> {
  const { legacyUserId: from, canonicalUserId: to } = input
  const report: ReconcileUserIdReport = {
    changed: false,
    users: 0,
    orgMemberships: 0,
    workspaceMemberships: 0,
    externalIdentities: 0,
    issueAssignees: 0,
    issueCreators: 0,
    collabIssues: 0,
    collabPlans: 0,
    collabRuns: 0,
    hostRebound: false,
  }
  if (from === to) return report
  report.changed = true
  const now = input.now ?? Date.now()
  const db = getDb()

  await db.transaction(
    "rw",
    [
      db.users,
      db.orgMemberships,
      db.workspaceMemberships,
      db.externalIdentities,
      db.issues,
      db.collabIssues,
      db.collabPlans,
      db.collabRuns,
    ],
    async () => {
      // The person: merge into a row the server may already have mirrored
      // under the canonical id, never overwrite it with the older copy.
      const legacy = await db.users.get(from)
      if (legacy) {
        const existing = await db.users.get(to)
        const merged: User = existing
          ? { ...legacy, ...existing, id: to, updatedAt: Math.max(existing.updatedAt, now) }
          : { ...legacy, id: to, updatedAt: now }
        await db.users.put(merged)
        await db.users.delete(from)
        report.users = 1
      }

      for (const row of await db.orgMemberships.where("userId").equals(from).toArray()) {
        const id = orgMembershipId(row.orgId, to)
        const existing = await db.orgMemberships.get(id)
        await db.orgMemberships.delete(row.id)
        // A row the server already wrote under the canonical id wins: it is
        // the authority, and the legacy row is at best the same fact.
        if (!existing) await db.orgMemberships.put({ ...row, id, userId: to, updatedAt: now })
        report.orgMemberships += 1
      }

      for (const row of await db.workspaceMemberships.where("userId").equals(from).toArray()) {
        const id = workspaceMembershipId(row.workspaceId, to)
        const existing = await db.workspaceMemberships.get(id)
        await db.workspaceMemberships.delete(row.id)
        if (!existing) {
          await db.workspaceMemberships.put({ ...row, id, userId: to, updatedAt: now })
        }
        report.workspaceMemberships += 1
      }

      for (const row of await db.externalIdentities.where("userId").equals(from).toArray()) {
        await db.externalIdentities.put({ ...row, userId: to })
        report.externalIdentities += 1
      }

      // Issues: the indexed assignee mirror finds assignments cheaply. The
      // creator has no index, so it is a scan, bounded by the local board.
      for (const issue of await db.issues.where("assigneeId").equals(from).toArray()) {
        if (issue.assigneeKind !== "human" || issue.assignee?.kind !== "human") continue
        await db.issues.put({
          ...issue,
          assignee: { ...issue.assignee, id: to },
          assigneeId: to,
          updatedAt: now,
        })
        report.issueAssignees += 1
      }
      const createdByLegacy = await db.issues
        .filter((issue) => issue.createdBy?.kind === "human" && issue.createdBy.id === from)
        .toArray()
      for (const issue of createdByLegacy) {
        await db.issues.put({ ...issue, createdBy: { ...issue.createdBy, id: to } })
        report.issueCreators += 1
      }

      // Collaboration mirrors: human actors only. Agents and teams keep
      // their own id spaces.
      for (const row of await db.collabIssues
        .filter((row) => isHuman(row.assignee, from) || isHuman(row.createdBy, from))
        .toArray()) {
        await db.collabIssues.put({
          ...row,
          ...(isHuman(row.assignee, from)
            ? { assignee: { ...rekeyActor(row.assignee!), id: to } }
            : {}),
          ...(isHuman(row.createdBy, from)
            ? { createdBy: { ...rekeyActor(row.createdBy), id: to } }
            : {}),
        })
        report.collabIssues += 1
      }
      for (const row of await db.collabPlans
        .filter((row) => isHuman(row.createdBy, from))
        .toArray()) {
        await db.collabPlans.put({ ...row, createdBy: { ...rekeyActor(row.createdBy), id: to } })
        report.collabPlans += 1
      }
      for (const row of await db.collabRuns
        .filter((row) => isHuman(row.startedBy, from))
        .toArray()) {
        await db.collabRuns.put({ ...row, startedBy: { ...rekeyActor(row.startedBy), id: to } })
        report.collabRuns += 1
      }
    }
  )

  // The binding lives in the registry database, outside the transaction
  // above. It goes last: a crash before this point leaves the projection
  // rekeyed and the binding stale, which the next refresh repairs, whereas the
  // reverse would leave a binding pointing at rows that no longer exist.
  const registry = deps.registry ?? new UserBindingRegistry()
  await registry.reconcileUserId(input.localAccountId, to, now)

  if (input.accessToken) {
    try {
      report.hostRebound = await bindHostPerson(
        {
          localAccountId: input.localAccountId,
          userId: to,
          accessToken: input.accessToken,
          ...(input.orgId ? { orgId: input.orgId } : {}),
        },
        deps.host ?? {}
      )
    } catch (error) {
      if (deps.onHostMirrorFailed) deps.onHostMirrorFailed(error)
      else console.warn("[identity] could not re-mirror the canonical person to the host", error)
    }
  }

  return report
}
