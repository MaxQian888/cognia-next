/**
 * Collaboration-plane issue source — ADR-0149 §6.
 *
 * Projects `collabIssues` rows onto the same board as local ones. Read-only,
 * because the collaboration server owns them: the board must grey the
 * affordances out rather than accept a gesture it would fail to honour. A write
 * path lands in a later cut, together with a conflict story for rows the client
 * does not own.
 *
 * Reads from Dexie only, like every other adapter. Refreshing the mirror is
 * `pullCollabIssues`'s job, so opening the board never blocks on the network
 * and an expired grant degrades to stale-but-visible rather than empty.
 *
 * # Why the identifier is not `KEY-n`
 *
 * Local issues print `MERC-7`. A collaboration row printing the same shape
 * would make two numbering schemes indistinguishable in conversation, which is
 * the mistake `github-source.ts` already refused to make. These print a short
 * form of the server id instead.
 */

import { listCollabIssues } from "@/lib/db/collab-issue-mirror"
import type { CollabIssueMirrorRow } from "@/lib/db/collab-issue-mirror-types"
import { statusCategoryOf } from "@/types/issues"
import type { IssueSourceAdapter, IssueSourceQuery, UnifiedIssueItem } from "@/types/issues/unified"
import { makeUnifiedIssueId, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"

import { getIssueSourceRegistry, type IssueSourceRegistry } from "./registry"

/**
 * Printed identifier. The server mints `iss_<uuid>`; showing all 32 hex
 * characters on a card is unreadable, and showing none makes two rows
 * indistinguishable, so it is trimmed to a prefix that stays copy-pasteable.
 */
export function collabIssueIdentifier(id: string): string {
  const body = id.startsWith("iss_") ? id.slice(4) : id
  return `#${body.slice(0, 8)}`
}

/** Project a mirrored row into the board's normalized shape. */
export function toUnifiedCollabIssue(row: CollabIssueMirrorRow): UnifiedIssueItem {
  return {
    unifiedId: makeUnifiedIssueId("collab", row.id),
    kind: "collab",
    sourceId: row.id,
    identifier: collabIssueIdentifier(row.id),
    title: row.title,
    ...(row.body ? { description: row.body } : {}),
    status: row.status,
    statusCategory: statusCategoryOf(row.status),
    priority: row.priority,
    // Both actors carry a required id — ADR-0149 §10 — so unlike the GitHub
    // adapter there is nothing to conditionally omit.
    ...(row.assignee ? { assignee: row.assignee } : {}),
    createdBy: row.createdBy,
    // Labels are not in the first cut of the plane; an empty list is honest,
    // and inventing namespaced ids for labels the server has never sent would
    // put filters on the board that can never match.
    labelIds: [],
    issueProjectId: row.issueProjectId,
    order: row.boardOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    origin: {
      tableName: "collabIssues",
      // No route renders a collaboration issue on its own yet, so the deep link
      // goes to the board it is already on rather than to a 404.
      deepLinkHref: "/issues",
      // "Shared" rather than "Team": `agent-team` already owns "Agent Team" in
      // the source filter, and two chips reading Team would be unreadable.
      sourceLabel: "Shared",
    },
    capabilities: READ_ONLY_ISSUE_CAPABILITIES,
  }
}

export const collabIssueSource: IssueSourceAdapter = {
  kind: "collab",
  label: "Shared",
  async list(query: IssueSourceQuery): Promise<UnifiedIssueItem[]> {
    // `projectId` is the workspace, and the mirror stores the server's
    // `workspaceId` — the same id space (ADR-0149 §1 kept `projectId` as the
    // workspace key rather than renaming it).
    const rows = await listCollabIssues({
      workspaceId: query.projectId,
      ...(query.issueProjectId ? { issueProjectId: query.issueProjectId } : {}),
    })
    return rows.map(toUnifiedCollabIssue)
  },
}

/**
 * Register the source. Named and shaped like its four siblings so
 * `bootIssueTracker` reads as one list rather than four spellings.
 */
export function registerCollabIssueSource(
  registry: IssueSourceRegistry = getIssueSourceRegistry()
) {
  registry.register(collabIssueSource)
}
