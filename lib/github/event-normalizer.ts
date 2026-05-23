/**
 * Normalize GitHub events from both transports (webhook + polling) into a
 * single `NormalizedGhEvent` shape. Downstream consumers (workflow triggers,
 * inbox renderer, audit logger) only deal with the normalized form.
 *
 * Webhook payloads come through {@link normalizeWebhook}; polling diffs come
 * through {@link normalizePollingDiff}. The `deliveryId` field is the source
 * of truth for dedup — webhook uses `x-github-delivery`, polling uses a hash
 * of (kind, repoFullName, primary id).
 */

import { createHash } from "node:crypto"
import type { NormalizedGhEvent, NormalizedGhEventKind } from "./types"

interface MinimalUser {
  login: string
}
interface MinimalIssue {
  number: number
  user?: MinimalUser
}
interface MinimalPr {
  number: number
  user?: MinimalUser
  head?: { sha?: string; ref?: string }
  base?: { ref?: string }
}
interface MinimalCheckRun {
  name: string
  conclusion?: string
}
interface MinimalRelease {
  tag_name: string
  name?: string | null
  draft: boolean
}

interface WebhookCommonPayload {
  action?: string
  repository?: { full_name: string }
  sender?: MinimalUser
  pull_request?: MinimalPr
  issue?: MinimalIssue
  release?: MinimalRelease
  check_run?: MinimalCheckRun
  ref?: string
}

export interface WebhookEnvelope {
  /** Value of the `x-github-event` header. */
  event: string
  /** Value of the `x-github-delivery` header. */
  deliveryId: string
  /** Parsed JSON payload. */
  payload: WebhookCommonPayload
  /** When the request was received. */
  receivedAt?: number
}

const EVENT_KIND_MAP: Record<string, NormalizedGhEventKind | null> = {
  "pull_request:opened": "pull_request.opened",
  "pull_request:synchronize": "pull_request.synchronize",
  "pull_request:closed": "pull_request.closed",
  "pull_request:review_requested": "pull_request.review_requested",
  "issues:opened": "issues.opened",
  "issues:closed": "issues.closed",
  "issues:assigned": "issues.assigned",
  "issues:labeled": "issues.labeled",
  "issue_comment:created": "issue_comment.created",
  "check_run:completed": "check_run.completed",
  "release:published": "release.published",
}

/**
 * Convert a webhook event to NormalizedGhEvent.
 *
 * Returns null when the (event, action) pair is not in our supported set —
 * caller should ack the delivery (200 OK) but not enqueue downstream work.
 */
export function normalizeWebhook(env: WebhookEnvelope): NormalizedGhEvent | null {
  const { event, deliveryId, payload } = env
  if (!payload?.repository?.full_name) return null
  const action = payload.action ?? ""
  const kind = EVENT_KIND_MAP[`${event}:${action}`] ?? null
  if (!kind) return null

  const seenAt = env.receivedAt ?? Date.now()
  const repoFullName = payload.repository.full_name

  const out: NormalizedGhEvent = {
    deliveryId,
    kind,
    repoFullName,
    rawEvent: event,
    rawAction: action || undefined,
    senderLogin: payload.sender?.login,
    seenAt,
    source: "webhook",
  }

  if (payload.pull_request) {
    out.pr = {
      repo: repoFullName,
      prNumber: payload.pull_request.number,
      headSha: payload.pull_request.head?.sha,
      baseRef: payload.pull_request.base?.ref,
      authorLogin: payload.pull_request.user?.login,
    }
    out.ref = payload.pull_request.head?.sha ?? payload.pull_request.head?.ref
  }
  if (payload.issue) {
    out.issue = {
      repo: repoFullName,
      issueNumber: payload.issue.number,
      authorLogin: payload.issue.user?.login,
    }
  }
  if (payload.release) {
    out.release = {
      tag: payload.release.tag_name,
      name: payload.release.name ?? undefined,
      draft: payload.release.draft,
    }
    out.ref = payload.release.tag_name
  }
  if (payload.check_run) {
    out.checkRun = {
      name: payload.check_run.name,
      conclusion: payload.check_run.conclusion,
    }
  }
  if (!out.ref && payload.ref) {
    out.ref = payload.ref
  }

  return out
}

// ============================================================================
// Polling normalization
// ============================================================================

export interface PollingDiffEntry {
  kind: NormalizedGhEventKind
  repoFullName: string
  /** Primary numeric id used for both dedup and the ref payload. */
  primaryId: number | string
  pr?: { prNumber: number; headSha?: string; baseRef?: string; authorLogin?: string }
  issue?: { issueNumber: number; authorLogin?: string }
  release?: { tag: string; name?: string; draft: boolean }
  senderLogin?: string
  seenAt?: number
}

/**
 * Polling sources don't have an x-github-delivery header. We synthesize a
 * deterministic id from (kind, repoFullName, primaryId) so re-polling the
 * same item is deduped against the events table.
 */
export function computePollingDeliveryId(
  kind: NormalizedGhEventKind,
  repoFullName: string,
  primaryId: number | string
): string {
  return createHash("sha1").update(`${kind}|${repoFullName}|${primaryId}`).digest("hex")
}

export function normalizePollingDiff(entry: PollingDiffEntry): NormalizedGhEvent {
  const seenAt = entry.seenAt ?? Date.now()
  const deliveryId = computePollingDeliveryId(entry.kind, entry.repoFullName, entry.primaryId)
  const out: NormalizedGhEvent = {
    deliveryId,
    kind: entry.kind,
    repoFullName: entry.repoFullName,
    rawEvent: entry.kind.split(".")[0],
    rawAction: entry.kind.split(".")[1],
    senderLogin: entry.senderLogin,
    seenAt,
    source: "polling",
  }
  if (entry.pr) {
    out.pr = { repo: entry.repoFullName, ...entry.pr }
    out.ref = entry.pr.headSha
  }
  if (entry.issue) {
    out.issue = { repo: entry.repoFullName, ...entry.issue }
  }
  if (entry.release) {
    out.release = entry.release
    out.ref = entry.release.tag
  }
  return out
}
