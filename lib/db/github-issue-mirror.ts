/**
 * GitHub issue mirror CRUD — Dexie table `githubIssueMirror` (schema v171).
 *
 * A read-through cache of `GET /repos/{owner}/{repo}/issues`. Rows reach the
 * board as read-only federated items via `lib/issues/sources/github-source.ts`;
 * nothing here is a source of truth, and nothing here is edited by the user.
 *
 * Deliberately NOT registered in `lib/sync/handlers/`: the mirror is
 * rebuildable from GitHub in one request, and syncing a cache that can drift
 * costs more than re-fetching it. The seven-site sync fan-out is reserved for
 * data that only exists locally.
 *
 * Mechanical module — no network, no gating. Fetching lives in
 * `lib/github/issues.ts`; this module only stores what that returns.
 */

import type { GithubIssueMirrorRow } from "./github-issue-mirror-types"
import { getDb } from "./schema"

/** Stable, human-legible primary key. */
export function githubMirrorId(repoFullName: string, number: number): string {
  return `${repoFullName}#${number}`
}

/**
 * Inverse of {@link githubMirrorId}. Lives here because this module owns the
 * format — a write-back surface that re-derived `owner/repo` and the number by
 * splitting the string itself would drift the moment the key changed.
 *
 * Splits on the LAST `#`: a repo name cannot contain one, but being explicit
 * costs nothing and a wrong split would address the wrong issue.
 */
export function parseGithubMirrorId(id: string): { repoFullName: string; number: number } | null {
  const hash = id.lastIndexOf("#")
  if (hash <= 0) return null
  const repoFullName = id.slice(0, hash)
  const number = Number(id.slice(hash + 1))
  if (!Number.isInteger(number) || number <= 0) return null
  return { repoFullName, number }
}

/**
 * Upsert a page of issues for one repo.
 *
 * `bulkPut` rather than add-or-patch: GitHub hands back the full issue on every
 * fetch, so the remote row always wins wholesale. There is no local edit to
 * preserve — that is the point of the mirror being read-only.
 */
export async function upsertGithubIssues(rows: readonly GithubIssueMirrorRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().githubIssueMirror.bulkPut([...rows])
}

export async function getGithubIssue(
  repoFullName: string,
  number: number
): Promise<GithubIssueMirrorRow | undefined> {
  return getDb().githubIssueMirror.get(githubMirrorId(repoFullName, number))
}

export interface ListGithubIssuesQuery {
  repoFullName?: string
  /** Narrow to the issues bound to one delivery container. */
  issueProjectId?: string
  /** Omit closed issues — the board's default for a "what's outstanding" read. */
  openOnly?: boolean
}

export async function listGithubIssues(
  query: ListGithubIssuesQuery = {}
): Promise<GithubIssueMirrorRow[]> {
  const db = getDb()

  let rows: GithubIssueMirrorRow[]
  if (query.repoFullName !== undefined) {
    rows = await db.githubIssueMirror.where("repoFullName").equals(query.repoFullName).toArray()
  } else if (query.issueProjectId !== undefined) {
    rows = await db.githubIssueMirror.where("issueProjectId").equals(query.issueProjectId).toArray()
  } else {
    rows = await db.githubIssueMirror.toArray()
  }

  return rows
    .filter((row) => {
      if (query.issueProjectId !== undefined && row.issueProjectId !== query.issueProjectId) {
        return false
      }
      if (query.openOnly && row.state !== "open") return false
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.number - b.number)
}

/**
 * Bind (or rebind) a repo's mirrored rows to a delivery container. Called when
 * a project gains or loses a `github-repo` resource, so the board can scope
 * federated rows the same way it scopes local ones.
 */
export async function bindRepoToIssueProject(
  repoFullName: string,
  issueProjectId: string | null
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.githubIssueMirror, async () => {
    const rows = await db.githubIssueMirror.where("repoFullName").equals(repoFullName).toArray()
    for (const row of rows) {
      const next = { ...row }
      if (issueProjectId === null) delete next.issueProjectId
      else next.issueProjectId = issueProjectId
      await db.githubIssueMirror.put(next)
    }
  })
}

/** Drop a repo's cache — on unbinding, or to force a clean re-fetch. */
export async function clearRepoMirror(repoFullName: string): Promise<void> {
  await getDb().githubIssueMirror.where("repoFullName").equals(repoFullName).delete()
}

/**
 * Drop single issues from the cache — ones GitHub no longer lists under this
 * repo: transferred to another repository, or deleted. Without this a
 * transferred issue lingers on the board for good, because an incremental
 * `since` walk never mentions an issue that left.
 */
export async function deleteGithubIssues(
  repoFullName: string,
  numbers: readonly number[]
): Promise<number> {
  if (numbers.length === 0) return 0
  const ids = numbers.map((number) => githubMirrorId(repoFullName, number))
  const table = getDb().githubIssueMirror
  const present = (await table.bulkGet(ids)).filter(Boolean).length
  await table.bulkDelete(ids)
  return present
}

/**
 * Remove every mirrored row of a repo that is not in `keepNumbers`. Only valid
 * after a COMPLETE, untruncated read of the repository (`state: "all"`, no
 * `since`): anything missing from that is gone from the repo, not merely
 * unchanged.
 */
export async function pruneRepoMirror(
  repoFullName: string,
  keepNumbers: ReadonlySet<number>
): Promise<number> {
  const rows = await getDb().githubIssueMirror.where("repoFullName").equals(repoFullName).toArray()
  const stale = rows.filter((row) => !keepNumbers.has(row.number)).map((row) => row.number)
  return deleteGithubIssues(repoFullName, stale)
}

/** Most recent `updatedAt` seen for a repo, for the next `since` watermark. */
export async function latestMirroredUpdate(repoFullName: string): Promise<number | undefined> {
  const rows = await getDb().githubIssueMirror.where("repoFullName").equals(repoFullName).toArray()
  if (rows.length === 0) return undefined
  return rows.reduce((max, row) => Math.max(max, row.updatedAt), 0)
}

/** The ETag to send on the next conditional fetch for a repo, if any. */
export async function repoMirrorEtag(repoFullName: string): Promise<string | undefined> {
  const rows = await getDb().githubIssueMirror.where("repoFullName").equals(repoFullName).toArray()
  // Every row in a page carries the page's ETag; the newest write wins.
  return rows.sort((a, b) => b.syncedAt - a.syncedAt)[0]?.etag
}

export async function countMirroredIssues(repoFullName: string): Promise<number> {
  return getDb().githubIssueMirror.where("repoFullName").equals(repoFullName).count()
}
