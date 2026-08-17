/**
 * "File this as an issue?" — the IM-side proposal (ADR-0132 slice ③).
 *
 * Both IM entry points — the assistant's `issue_create` tool (a natural-
 * language ask) and a quoted message — converge here: resolve the candidate
 * delivery containers, push the confirmation card, and STOP. Nothing is
 * written until a project button is pressed; that click lands in
 * `callback-handler.ts` (`create`), which files the issue, remembers the
 * project on the conversation and consumes the card.
 *
 * Candidate projects: the conversation's remembered `issueProjectId` first,
 * then the workspace's containers by recency, capped at `MAX_PROJECT_BUTTONS`
 * (a card row cannot hold more, and five is already a scroll on a phone).
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import { parseConversationKey } from "@/types/connectors/event"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import type { IssueProject } from "@/types/issues"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { buildCreateIssueConfirmSurface, type IssueDraft } from "./card"
import type { IssueImPushDeps } from "./push"

export const MAX_PROJECT_BUTTONS = 5

export interface ProposeIssueInput {
  adapterId: string
  conversationKey: string
  /** Owning workspace the issue would land in. */
  workspaceId: string
  title: string
  description?: string
  /** Platform message id the draft was quoted from. */
  sourceMessageId?: string
}

export type ProposeIssueResult =
  | { status: "proposed"; surfaceId: string; draftId: string; projectIds: string[] }
  | { status: "no-projects" }
  | { status: "pii_blocked" }

/** Candidate containers, remembered project first, capped. Exported for tests. */
export async function resolveCandidateProjects(
  workspaceId: string,
  conversationKey: string,
  deps: {
    listProjects: (workspaceId: string) => Promise<IssueProject[]>
    remembered: (conversationKey: string) => Promise<string | undefined>
  }
): Promise<{ projects: IssueProject[]; defaultProjectId?: string }> {
  const [all, remembered] = await Promise.all([
    deps.listProjects(workspaceId),
    deps.remembered(conversationKey),
  ])
  const sorted = [...all].sort((a, b) => b.updatedAt - a.updatedAt)
  const rememberedRow = remembered ? sorted.find((p) => p.id === remembered) : undefined
  const ordered = rememberedRow
    ? [rememberedRow, ...sorted.filter((p) => p.id !== rememberedRow.id)]
    : sorted
  return {
    projects: ordered.slice(0, MAX_PROJECT_BUTTONS),
    ...(rememberedRow ? { defaultProjectId: rememberedRow.id } : {}),
  }
}

export interface ProposeIssueDeps {
  listProjects: (workspaceId: string) => Promise<IssueProject[]>
  remembered: (conversationKey: string) => Promise<string | undefined>
  push: Pick<IssueImPushDeps, "enqueue" | "buildSegment" | "audit" | "isPiiSafe" | "now">
  newId: () => string
}

async function defaultDeps(): Promise<ProposeIssueDeps> {
  const [{ enqueueGoverned }, { buildA2UISegment }, { appendAudit }, { hasNoLeakingPii }] =
    await Promise.all([
      import("@/lib/connectors/delivery-gateway"),
      import("@/lib/connectors/a2ui-bridge/a2ui-to-segments"),
      import("@/lib/connectors/audit"),
      import("@cognia/redact"),
    ])
  return {
    listProjects: (workspaceId) => listIssueProjects({ projectId: workspaceId }),
    remembered: async (conversationKey) =>
      (await readForResolution(conversationKey))?.issueProjectId ?? undefined,
    push: {
      enqueue: (input) => enqueueGoverned(input as never),
      buildSegment: (surfaceId, content: A2UISegmentContent) =>
        buildA2UISegment(surfaceId, content) as never,
      audit: (entry) => appendAudit(entry as never),
      isPiiSafe: hasNoLeakingPii,
      now: Date.now,
    },
    newId: () => newIdempotencyKey().slice(0, 10),
  }
}

/** Push the confirmation card. Writes nothing. */
export async function proposeIssueFromIm(
  input: ProposeIssueInput,
  overrides: Partial<ProposeIssueDeps> = {}
): Promise<ProposeIssueResult> {
  const deps: ProposeIssueDeps = { ...(await defaultDeps()), ...overrides }
  const { projects, defaultProjectId } = await resolveCandidateProjects(
    input.workspaceId,
    input.conversationKey,
    deps
  )
  if (projects.length === 0) return { status: "no-projects" }

  const draft: IssueDraft = {
    draftId: deps.newId(),
    title: input.title.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
  }
  const surfaceId = `issue-create:${draft.draftId}`
  const surface = buildCreateIssueConfirmSurface({
    surfaceId,
    draft,
    projects,
    ...(defaultProjectId ? { defaultProjectId } : {}),
  })
  const mirror = String(surface.widget?.fallbackText ?? "")
  if (!deps.push.isPiiSafe(mirror)) {
    await deps.push.audit({
      adapterId: input.adapterId,
      kind: "issue.im_pii_blocked",
      at: deps.push.now(),
      conversationKey: input.conversationKey,
      reason: "pii_blocked",
      fields: { draftId: draft.draftId },
    })
    return { status: "pii_blocked" }
  }
  const platform = parseConversationKey(input.conversationKey).platform
  await deps.push.enqueue({
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    request: {
      conversationRef: { platform, adapterId: input.adapterId },
      segments: [deps.push.buildSegment(surfaceId, surface)],
      metadata: { idempotencyKey: `issue-propose:${draft.draftId}` },
    },
    source: "skill",
  })
  return {
    status: "proposed",
    surfaceId,
    draftId: draft.draftId,
    projectIds: projects.map((p) => p.id),
  }
}
