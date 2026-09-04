/**
 * Shared vocabulary and the single write path for the `issue.*` family.
 *
 * Before this module the family was two tools: `issue.create` and
 * `issue.list_projects`. An agent could file an issue and then never touch it
 * again, which made the tracker write-only from a model's point of view.
 *
 * Two rules hold everything here together:
 *
 *   1. **Every write goes through `lib/issues/bulk-actions.ts`.** That module
 *      is the board's own gate: it asks each row's `capabilities` and the
 *      run-active guard before writing, and it is what stops an agent moving
 *      an issue the runtime currently owns or editing a federated row that
 *      only GitHub can change. Calling `lib/db/issues.ts` directly, the way
 *      `issue.create` used to, walks past all of it.
 *   2. **The actor is honest.** A skill invocation is the assistant acting,
 *      never the user typing, so writes are attributed to the session's
 *      character rather than to `{ kind: "human" }`. The activity trail is the
 *      only record of who changed an issue, and it was claiming a person did.
 */

import { z } from "zod"

import type { Issue, IssueActor, IssueProject } from "@/types/issues"
import type { IssueBulkAction, IssueBulkOutcome } from "@/lib/issues/bulk-actions"
import type { BuiltInSkillContext } from "../types"

export const ISSUE_STATUS_VALUES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const

export const ISSUE_PRIORITY_VALUES = ["urgent", "high", "medium", "low", "none"] as const

export const issueRefSchema = z
  .string()
  .min(1)
  .describe(
    "The issue, either its printed identifier (e.g. 'MERC-12') or its raw id. Identifiers are what the user says, so prefer them."
  )

export const projectRefSchema = z
  .string()
  .min(1)
  .describe("The delivery container, either its key (e.g. 'MERC') or its raw id.")

/**
 * Read one field off the calling session, or `undefined`.
 *
 * Swallows the lookup failure on purpose. A session id that no longer resolves
 * is a reason to fall back to the workspace default and to an unnamed agent,
 * not a reason for the whole tool call to fail, and skills also run in hosts
 * where the session table is not reachable at all.
 */
async function sessionField<T>(
  sessionId: string | undefined,
  pick: (session: import("@cognia/agent-config-types").ChatSession) => T | undefined
): Promise<T | undefined> {
  if (!sessionId) return undefined
  try {
    const { getSession } = await import("@/lib/db/sessions")
    const session = await getSession(sessionId)
    return session ? pick(session) : undefined
  } catch {
    return undefined
  }
}

/**
 * The workspace this invocation writes to.
 *
 * The session's own workspace wins over the UI's active one: a conversation
 * bound to a workspace must not file into whichever workspace the window
 * happens to be showing, and an IM or scheduled session has no window at all.
 */
export async function resolveWorkspaceId(ctx: Pick<BuiltInSkillContext, "sessionId">) {
  const bound = await sessionField(ctx.sessionId, (session) => session.projectId)
  if (bound) return bound
  const { useProjectStore } = await import("@/stores/project/project-store")
  const active = useProjectStore.getState().activeProjectId
  if (active) return active
  const { ensureDefaultProject } = await import("@/lib/db/project-scope")
  return (await ensureDefaultProject()).id
}

/**
 * Who the trail should say did this.
 *
 * Falls back to an id-less agent rather than to a human: a skill call is an
 * agent acting even when the character behind it cannot be resolved, and
 * naming the wrong kind is worse than naming no id.
 */
export async function resolveIssueActor(
  ctx: Pick<BuiltInSkillContext, "sessionId">
): Promise<IssueActor> {
  const characterId = await sessionField(ctx.sessionId, (session) => session.characterId)
  if (!characterId) return { kind: "agent" }
  try {
    const { getCharacter } = await import("@/lib/db/characters")
    const character = await getCharacter(characterId)
    return { kind: "agent", id: characterId, ...(character?.name ? { label: character.name } : {}) }
  } catch {
    return { kind: "agent", id: characterId }
  }
}

/** An issue named by identifier or id, refused when it is outside `workspaceId`. */
export async function resolveIssue(ref: string, workspaceId: string): Promise<Issue> {
  const { getIssue, getIssueByIdentifier } = await import("@/lib/db/issues")
  const trimmed = ref.trim()
  const found =
    (await getIssueByIdentifier(trimmed.toUpperCase())) ?? (await getIssue(trimmed)) ?? undefined
  if (!found) throw new Error(`No issue matches ${JSON.stringify(ref)}`)
  // Scope check, not a formality: identifiers are unique across every
  // workspace, so a bare `MERC-12` can name a row this session may not touch.
  if (found.projectId !== workspaceId) {
    throw new Error(`Issue ${found.identifier} belongs to another workspace`)
  }
  return found
}

/** A container named by key or id, refused when it is outside `workspaceId`. */
export async function resolveIssueProject(ref: string, workspaceId: string): Promise<IssueProject> {
  const { getIssueProject, getIssueProjectByKey } = await import("@/lib/db/issue-projects")
  const trimmed = ref.trim()
  const found =
    (await getIssueProjectByKey(trimmed.toUpperCase())) ?? (await getIssueProject(trimmed))
  if (!found) throw new Error(`No issue project matches ${JSON.stringify(ref)}`)
  if (found.projectId !== workspaceId) {
    throw new Error(`Issue project ${found.key} belongs to another workspace`)
  }
  return found
}

/**
 * Apply one board action to one issue through the board's own gate.
 *
 * Returns the gate's verdict rather than throwing on refusal: "the runtime
 * owns this issue right now" is an answer the model should relay, not an
 * error it should retry.
 */
export async function applyIssueAction(
  issue: Issue,
  action: IssueBulkAction,
  by: IssueActor
): Promise<IssueBulkOutcome> {
  const { toUnifiedIssue } = await import("@/lib/issues/sources/local-source")
  const { hasActiveIssueRun } = await import("@/lib/db/issue-runs")
  const { applyIssueBulkAction } = await import("@/lib/issues/bulk-actions")

  const item = toUnifiedIssue(issue)
  const running = (await hasActiveIssueRun(issue.id))
    ? new Set([item.unifiedId])
    : new Set<string>()
  return applyIssueBulkAction([item], action, by, running)
}

/** Turn a gate outcome into the shape every write tool reports. */
export function describeOutcome(outcome: IssueBulkOutcome, field: string) {
  if (outcome.applied > 0) return { field, status: "applied" as const }
  if (outcome.failed > 0) return { field, status: "failed" as const }
  return { field, status: "refused" as const, reason: outcome.reason ?? "unknown" }
}

/** The one issue shape every tool in this family returns. */
export function summariseIssue(issue: Issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(issue.description ? { description: issue.description } : {}),
    status: issue.status,
    priority: issue.priority,
    issueProjectId: issue.issueProjectId,
    assignee: issue.assignee ?? null,
    labelIds: issue.labelIds,
    createdBy: issue.createdBy,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(issue.githubRef ? { github: issue.githubRef } : {}),
  }
}
