/**
 * github-poll — scheduled task handler.
 *
 * Polls each enabled repo for new PRs / issues / releases. Uses ETag-based
 * conditional GET so the cost stays at ~1 API call per repo per cycle until
 * something actually changes.
 *
 * The scheduler invokes `runGithubPoll` every `everyMs` (default 5 min); the
 * handler iterates the `repos` table, calls Octokit per repo, normalizes
 * results into `NormalizedGhEvent`s, and dedupes against the `events` table
 * before emitting downstream.
 */

import type { Octokit } from "@octokit/core"
import { getOctokitForRepo } from "@/lib/github/octokit-factory"
import { computePollingDeliveryId, normalizePollingDiff } from "@/lib/github/event-normalizer"
import type { GhRepoEntry, NormalizedGhEvent, NormalizedGhEventKind } from "@/lib/github/types"

export interface PollContext {
  /** Dexie table for the namespaced repos table. */
  reposTable: GhTable<GhRepoEntry, string>
  /** Dexie table for the namespaced events table. */
  eventsTable: GhTable<NormalizedGhEvent, string>
  /**
   * Override for octokit acquisition. Defaults to {@link getOctokitForRepo}.
   * Lets tests inject a stubbed Octokit without touching the real API.
   */
  octokitFor?: (repo: GhRepoEntry) => Promise<Octokit>
  /** Callback for each new event — typically `bus.inbound(event)`. */
  onEvent?: (event: NormalizedGhEvent) => Promise<void> | void
  /** Logger. */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void }
  /** Time source override (for tests). */
  now?: () => number
}

/**
 * Minimal Dexie-Table-shaped surface so the poll module doesn't depend on
 * Dexie types directly. Both `Dexie.Table` and the M0 PluginDexieAPI table
 * implement this surface.
 */
export interface GhTable<TRow, _TKey = unknown> {
  toArray(): Promise<TRow[]>
  get(key: unknown): Promise<TRow | undefined>
  put(row: TRow): Promise<unknown>
  bulkPut(rows: TRow[]): Promise<unknown>
}

interface RepoIssueRow {
  number: number
  pull_request?: unknown
  user?: { login: string }
  state: string
  updated_at: string
}

interface RepoPullRow {
  number: number
  user?: { login: string }
  state: string
  head?: { sha?: string; ref?: string }
  base?: { ref?: string }
  updated_at: string
}

interface RepoReleaseRow {
  tag_name: string
  name?: string | null
  draft: boolean
  published_at?: string | null
}

interface PollResult {
  repoFullName: string
  newEventCount: number
  /** True when the repo's ETag hadn't changed → no work needed. */
  notModified: boolean
  /** True when the repo errored and was skipped. */
  errored: boolean
}

const DEFAULT_OCTOKIT_FOR = (repo: GhRepoEntry): Promise<Octokit> => {
  if (repo.credentialMode === "pat") {
    if (!repo.patKeyringId) throw new Error(`repo ${repo.fullName} missing patKeyringId`)
    // Real implementation looks up the PAT in keyring via the plugin secrets
    // API. The lookup is async and side-effect-laden; tests inject a stub.
    return Promise.reject(
      new Error(`PAT lookup is wired by the plugin entry, not the polling task itself`)
    )
  }
  if (!repo.installationId) throw new Error(`repo ${repo.fullName} missing installationId`)
  return getOctokitForRepo({
    repoFullName: repo.fullName,
    mode: "app",
    // App credentials come from the plugin secrets store; the entry binds
    // the secrets API and overrides `octokitFor`. We throw if reached.
    app: { appId: 0, privateKey: "", installationId: repo.installationId },
  }) as unknown as Promise<Octokit>
}

/**
 * Iterate every enabled repo and poll for new events.
 */
export async function runGithubPoll(ctx: PollContext): Promise<PollResult[]> {
  const log = ctx.logger ?? {}
  const now = ctx.now ?? Date.now
  const octokitFor = ctx.octokitFor ?? DEFAULT_OCTOKIT_FOR

  const repos = await ctx.reposTable.toArray()
  const results: PollResult[] = []

  for (const repo of repos) {
    if (repo.triggerMode !== "polling") continue
    try {
      const result = await pollRepo(repo, ctx, octokitFor, now())
      results.push(result)
    } catch (err) {
      log.error?.(
        `[github-poll] ${repo.fullName} failed: ${err instanceof Error ? err.message : String(err)}`
      )
      results.push({
        repoFullName: repo.fullName,
        newEventCount: 0,
        notModified: false,
        errored: true,
      })
    }
  }
  return results
}

async function pollRepo(
  repo: GhRepoEntry,
  ctx: PollContext,
  octokitFor: (repo: GhRepoEntry) => Promise<Octokit>,
  now: number
): Promise<PollResult> {
  const octokit = await octokitFor(repo)
  const headers: Record<string, string> = repo.pollEtag ? { "if-none-match": repo.pollEtag } : {}

  const [owner, name] = repo.fullName.split("/")
  if (!owner || !name) throw new Error(`bad repo full name "${repo.fullName}"`)

  // Single endpoint covering recent activity. /events drops items > 90 days.
  const response = (await octokit.request("GET /repos/{owner}/{repo}/events", {
    owner,
    repo: name,
    headers,
  })) as { status: number; headers: Record<string, string>; data: unknown[] }

  if (response.status === 304) {
    return {
      repoFullName: repo.fullName,
      newEventCount: 0,
      notModified: true,
      errored: false,
    }
  }

  // Persist the new ETag for the next cycle.
  const newEtag = response.headers["etag"]
  if (newEtag && newEtag !== repo.pollEtag) {
    await ctx.reposTable.put({ ...repo, pollEtag: newEtag, lastDeliveryAt: now })
  }

  const newEvents: NormalizedGhEvent[] = []
  for (const raw of response.data) {
    const evt = mapEventRow(repo.fullName, raw, now)
    if (!evt) continue
    const existing = await ctx.eventsTable.get(evt.deliveryId)
    if (existing) continue
    newEvents.push(evt)
  }

  if (newEvents.length > 0) {
    await ctx.eventsTable.bulkPut(newEvents)
    if (ctx.onEvent) {
      for (const evt of newEvents) {
        await ctx.onEvent(evt)
      }
    }
  }

  return {
    repoFullName: repo.fullName,
    newEventCount: newEvents.length,
    notModified: false,
    errored: false,
  }
}

interface RawEventEnvelope {
  type?: string
  payload?: {
    action?: string
    issue?: RepoIssueRow
    pull_request?: RepoPullRow
    release?: RepoReleaseRow
  }
  actor?: { login: string }
  created_at?: string
}

/**
 * Map one /events row to a NormalizedGhEvent. Returns null when the event
 * type is not in our supported set (silently dropped).
 */
function mapEventRow(repoFullName: string, raw: unknown, now: number): NormalizedGhEvent | null {
  const env = raw as RawEventEnvelope
  if (!env?.type || !env?.payload) return null
  const senderLogin = env.actor?.login
  const seenAt = env.created_at ? Date.parse(env.created_at) : now

  const action = env.payload.action ?? ""
  const kind = mapEventKind(env.type, action, env.payload)
  if (!kind) return null

  const primaryId =
    env.payload.pull_request?.number ??
    env.payload.issue?.number ??
    env.payload.release?.tag_name ??
    `${env.type}:${action}:${seenAt}`

  return normalizePollingDiff({
    kind,
    repoFullName,
    primaryId,
    pr: env.payload.pull_request
      ? {
          prNumber: env.payload.pull_request.number,
          headSha: env.payload.pull_request.head?.sha,
          baseRef: env.payload.pull_request.base?.ref,
          authorLogin: env.payload.pull_request.user?.login,
        }
      : undefined,
    issue:
      env.payload.issue && !env.payload.issue.pull_request
        ? {
            issueNumber: env.payload.issue.number,
            authorLogin: env.payload.issue.user?.login,
          }
        : undefined,
    release: env.payload.release
      ? {
          tag: env.payload.release.tag_name,
          name: env.payload.release.name ?? undefined,
          draft: env.payload.release.draft,
        }
      : undefined,
    senderLogin,
    seenAt,
  })
}

function mapEventKind(
  type: string,
  action: string,
  payload: RawEventEnvelope["payload"]
): NormalizedGhEventKind | null {
  switch (type) {
    case "PullRequestEvent":
      if (action === "opened") return "pull_request.opened"
      if (action === "closed") return "pull_request.closed"
      if (action === "synchronize") return "pull_request.synchronize"
      return null
    case "IssuesEvent":
      if (payload?.issue?.pull_request) return null // ignore PR-as-issue
      if (action === "opened") return "issues.opened"
      if (action === "closed") return "issues.closed"
      if (action === "labeled") return "issues.labeled"
      if (action === "assigned") return "issues.assigned"
      return null
    case "IssueCommentEvent":
      if (action === "created") return "issue_comment.created"
      return null
    case "ReleaseEvent":
      if (action === "published") return "release.published"
      return null
    default:
      return null
  }
}

/** Test-only export — exposed so the unit test can verify the mapper. */
export const _internal = {
  mapEventRow,
  mapEventKind,
  computePollingDeliveryId,
}
