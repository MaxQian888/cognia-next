/**
 * Outbound helpers for the issue tracker's IM side (ADR-0132 slice ③).
 *
 * Everything leaves through `enqueueGoverned` (`lib/connectors/delivery-gateway`),
 * the one governed outbound queue, tagged `source: "skill"` (an automated
 * source the gateway rate-governs). Text passes the PII gate
 * (`hasNoLeakingPii`) FIRST — an issue title or description typed on the
 * desktop can carry anything, and this is the boundary where it would leave
 * the machine. A blocked push is audited, never sent, never thrown.
 *
 * `pushIssueCard` derives the card's move buttons from the state machine
 * (`allowedIssueMoveTargets`) and its Run button from the run registry, so
 * the card can only offer what the desktop board would.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { parseConversationKey } from "@/types/connectors/event"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { Issue } from "@/types/issues"
import { getIssueProject } from "@/lib/db/issue-projects"
import { hasActiveIssueRun } from "@/lib/db/issue-runs"
import { allowedIssueMoveTargets } from "@/lib/issues/state-machine"
import { listIssueRunOptions } from "@/lib/issues/run/registry"
import { issueHref } from "@/lib/issues/sources/local-source"
import { buildIssueCardSurface, type IssueCardLabels } from "./card"

/** Where the desktop board lives for deep links pushed into IM. */
export const ISSUE_BOARD_ORIGIN_ENV = "NEXT_PUBLIC_APP_ORIGIN"

/** Absolute deep link when an app origin is configured, app-relative otherwise. */
export function issueOpenHref(issueId: string, origin?: string): string {
  const base = origin ?? process.env[ISSUE_BOARD_ORIGIN_ENV] ?? ""
  return `${base.replace(/\/$/, "")}${issueHref(issueId)}`
}

export interface IssueImPushDeps {
  enqueue: (input: {
    adapterId: string
    conversationKey: string
    request: {
      conversationRef: { platform: string; adapterId: string }
      segments: Array<Record<string, unknown>>
      metadata: { idempotencyKey: string }
    }
    source: "skill"
  }) => Promise<unknown>
  buildSegment: (surfaceId: string, content: A2UISegmentContent) => Record<string, unknown>
  audit: (entry: {
    adapterId: string
    kind: string
    at: number
    conversationKey?: string
    reason?: string
    message?: string
    fields?: Record<string, unknown>
  }) => Promise<unknown>
  isPiiSafe: (text: string) => boolean
  now: () => number
}

async function defaultDeps(): Promise<IssueImPushDeps> {
  const [{ enqueueGoverned }, { buildA2UISegment }, { appendAudit }] = await Promise.all([
    import("@/lib/connectors/delivery-gateway"),
    import("@/lib/connectors/a2ui-bridge/a2ui-to-segments"),
    import("@/lib/connectors/audit"),
  ])
  return {
    enqueue: (input) => enqueueGoverned(input as never),
    buildSegment: (surfaceId, content) => buildA2UISegment(surfaceId, content) as never,
    audit: (entry) => appendAudit(entry as never),
    isPiiSafe: hasNoLeakingPii,
    now: Date.now,
  }
}

async function resolveDeps(overrides?: Partial<IssueImPushDeps>): Promise<IssueImPushDeps> {
  const base = await defaultDeps()
  return { ...base, ...(overrides ?? {}) }
}

export interface PushIssueTextInput {
  adapterId: string
  conversationKey: string
  text: string
  idempotencyKey: string
}

/** Push a plain-text reply. PII-gated; a blocked text is audited and skipped. */
export async function pushIssueText(
  input: PushIssueTextInput,
  overrides?: Partial<IssueImPushDeps>
): Promise<"sent" | "pii_blocked"> {
  const deps = await resolveDeps(overrides)
  if (!deps.isPiiSafe(input.text)) {
    await deps.audit({
      adapterId: input.adapterId,
      kind: "issue.im_pii_blocked",
      at: deps.now(),
      conversationKey: input.conversationKey,
      reason: "pii_blocked",
    })
    return "pii_blocked"
  }
  const platform = parseConversationKey(input.conversationKey).platform
  await deps.enqueue({
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    request: {
      conversationRef: { platform, adapterId: input.adapterId },
      segments: [{ type: "text", text: input.text }],
      metadata: { idempotencyKey: input.idempotencyKey },
    },
    source: "skill",
  })
  return "sent"
}

export interface PushIssueCardInput {
  adapterId: string
  conversationKey: string
  issue: Issue
  /** Defaults to a fresh idempotency key. */
  idempotencyKey?: string
  labels?: Partial<IssueCardLabels>
  /** Test injection — otherwise derived from state machine + run registry. */
  runActive?: boolean
  canRun?: boolean
}

/**
 * Push the interactive issue card. Its buttons are derived from what the
 * issue may legally do right now. PII-gated on the card's text.
 */
export async function pushIssueCard(
  input: PushIssueCardInput,
  overrides?: Partial<IssueImPushDeps>
): Promise<{ status: "sent" | "pii_blocked"; surfaceId: string }> {
  const deps = await resolveDeps(overrides)
  const { issue } = input
  const runActive = input.runActive ?? (await hasActiveIssueRun(issue.id))
  const moveTargets = allowedIssueMoveTargets(FULL_ISSUE_CAPABILITIES, issue.status, {
    runActive,
  })
    // The runtime owns in_progress; the card never offers it as a target.
    .filter((to) => to !== "in_progress")
  const canRun =
    input.canRun ??
    (!runActive && (await listIssueRunOptions(issue.id)).some((option) => option.verdict.ok))
  const project = await getIssueProject(issue.issueProjectId)
  const surfaceId = `issue:${issue.id}:${newIdempotencyKey().slice(0, 8)}`
  const surface = buildIssueCardSurface({
    surfaceId,
    issue,
    ...(project ? { project } : {}),
    moveTargets,
    canRun,
    runActive,
    openHref: issueOpenHref(issue.id),
    ...(input.labels ? { labels: input.labels } : {}),
  })
  const mirror = String(surface.widget?.fallbackText ?? "")
  if (!deps.isPiiSafe(mirror)) {
    await deps.audit({
      adapterId: input.adapterId,
      kind: "issue.im_pii_blocked",
      at: deps.now(),
      conversationKey: input.conversationKey,
      reason: "pii_blocked",
      fields: { issueId: issue.id },
    })
    return { status: "pii_blocked", surfaceId }
  }
  const platform = parseConversationKey(input.conversationKey).platform
  await deps.enqueue({
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    request: {
      conversationRef: { platform, adapterId: input.adapterId },
      segments: [deps.buildSegment(surfaceId, surface)],
      metadata: { idempotencyKey: input.idempotencyKey ?? newIdempotencyKey() },
    },
    source: "skill",
  })
  return { status: "sent", surfaceId }
}
