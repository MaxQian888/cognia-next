import type { UIMessage } from "ai"
import type {
  AttachedChildSession,
  AttachedSessionContextMode,
  ChatSession,
  SessionSurfaceBinding,
} from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { renderBranchSeed } from "./branch-session"
import { createResourceWorkbenchSession } from "@/lib/db/resource-workbench-sessions"
import { listMessages } from "@/lib/db/messages"
import { deleteSession, getSession, listSessionBranches, updateSession } from "@/lib/db/sessions"

export type AttachedSessionWorkspace = "shared" | "independent"

export interface CreateAttachedSessionInput {
  parentSessionId: string
  title: string
  prompt: string
  context: AttachedSessionContextMode
  workspace: AttachedSessionWorkspace
  /**
   * Extra columns written with the attachment in the same update, so a
   * specialised child (a project thread, ADR-0204) is never observable half
   * built. Cannot override the attachment's own columns.
   */
  extra?: Omit<
    Partial<ChatSession>,
    "id" | "parentSessionId" | "attachedChild" | "spawnedTask" | "branchSeed"
  >
}

export interface AttachedSessionDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  listChildren: (parentSessionId: string) => Promise<ChatSession[]>
  createChild: (binding: SessionSurfaceBinding, title: string) => Promise<ChatSession>
  listMessages: (sessionId: string) => Promise<UIMessage[]>
  updateSession: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
  deleteChild: (id: string) => Promise<unknown>
  gateInheritedContent: (content: string) => boolean
  now: () => number
}

/**
 * The production dependencies. Exported so a caller that needs a different
 * child surface (a visible top-level session instead of a workbench aside)
 * overrides just `createChild` and keeps everything else.
 */
export function defaultAttachedSessionDeps(): AttachedSessionDeps {
  return {
    getSession,
    listChildren: listSessionBranches,
    createChild: createResourceWorkbenchSession,
    listMessages,
    updateSession,
    deleteChild: deleteSession,
    gateInheritedContent: hasNoLeakingPiiDeep,
    now: Date.now,
  }
}

function validateContext(context: AttachedSessionContextMode): void {
  if (
    context.mode === "last-n" &&
    (!Number.isInteger(context.turns) || context.turns <= 0 || context.turns > 100)
  ) {
    throw new Error("Attached-session last-N context must contain between 1 and 100 turns")
  }
}

function childExecutionContext(
  parent: ChatSession,
  childId: string,
  workspace: AttachedSessionWorkspace
): ChatSession["executionContext"] {
  if (workspace !== "shared" || !parent.executionContext) return undefined
  const workspaceKey =
    parent.executionContext.workspaceBinding?.kind === "managed"
      ? parent.executionContext.workspaceBinding.workspaceId
      : childId
  return {
    ...parent.executionContext,
    taskWorkspace: {
      taskId: `task-workspace:${childId}`,
      workspaceKey,
    },
  }
}

export async function createAttachedSession(
  input: CreateAttachedSessionInput,
  deps: AttachedSessionDeps = defaultAttachedSessionDeps()
): Promise<ChatSession> {
  const parentSessionId = input.parentSessionId.trim()
  const title = input.title.trim()
  const prompt = input.prompt.trim()
  if (!parentSessionId) throw new Error("An attached session needs a parent")
  if (!title) throw new Error("An attached session needs a title")
  if (!prompt) throw new Error("An attached session needs an initial prompt")
  validateContext(input.context)

  const parent = await deps.getSession(parentSessionId)
  if (!parent) throw new Error(`Parent session ${parentSessionId} was not found`)

  let inheritedContent: string | undefined
  if (input.context.mode === "last-n") {
    const messages = await deps.listMessages(parentSessionId)
    inheritedContent = renderBranchSeed(messages.slice(-input.context.turns)).content || undefined
    if (inheritedContent && !deps.gateInheritedContent(inheritedContent)) {
      throw new Error("The attached-session context was blocked by the PII redaction gate")
    }
  } else if (input.context.mode === "full") {
    inheritedContent =
      renderBranchSeed(await deps.listMessages(parentSessionId)).content || undefined
    if (inheritedContent && !deps.gateInheritedContent(inheritedContent)) {
      throw new Error("The attached-session context was blocked by the PII redaction gate")
    }
  }

  const child = await deps.createChild({ kind: "session", sessionId: parentSessionId }, title)
  const now = deps.now()
  const attachedChild: AttachedChildSession = {
    parentSessionId,
    lifecycleOwnerSessionId: parentSessionId,
    context: input.context,
    workspace: input.workspace,
    status: "staged",
    createdAt: now,
    updatedAt: now,
  }
  // An independent child keeps whatever placement its creator already gave it
  // (a thread's own managed worktree); only a shared child borrows the parent's.
  const patch: Partial<ChatSession> = {
    ...input.extra,
    parentSessionId,
    attachedChild,
    workingDir: input.workspace === "shared" ? parent.workingDir : child.workingDir,
    executionContext:
      childExecutionContext(parent, child.id, input.workspace) ??
      (input.workspace === "independent" ? child.executionContext : undefined),
    spawnedTask: {
      mode: input.context.mode === "none" ? "aside" : "inherit",
      pendingPrompt: prompt,
    },
  }
  if (input.context.mode === "full" && parent.sdkSessionId) {
    patch.forkedFromSdkSessionId = parent.sdkSessionId
  } else if (inheritedContent) {
    patch.branchSeed = { kind: "transcript", content: inheritedContent }
  }
  try {
    await deps.updateSession(child.id, patch)
  } catch (error) {
    await deps.deleteChild(child.id).catch(() => undefined)
    throw error
  }
  return { ...child, ...patch }
}

/**
 * Retire a staged first prompt once it has been submitted (or has gone stale
 * because the conversation already has turns). Keeps the task mode, drops the
 * prompt, so a reload can never submit it twice. The one writer of this
 * transition for every surface that consumes a staged prompt.
 */
export async function consumeStagedPrompt(
  sessionId: string,
  mode: NonNullable<ChatSession["spawnedTask"]>["mode"],
  deps: Pick<AttachedSessionDeps, "updateSession"> = defaultAttachedSessionDeps()
): Promise<void> {
  await deps.updateSession(sessionId, { spawnedTask: { mode } })
}

async function requireAttachedSession(
  childSessionId: string,
  deps: Pick<AttachedSessionDeps, "getSession">
): Promise<ChatSession & { attachedChild: AttachedChildSession }> {
  const child = await deps.getSession(childSessionId)
  if (!child?.attachedChild) {
    throw new Error(`Session ${childSessionId} is not an attached session`)
  }
  return child as ChatSession & { attachedChild: AttachedChildSession }
}

export async function markAttachedSessionRunning(
  childSessionId: string,
  deps: AttachedSessionDeps = defaultAttachedSessionDeps()
): Promise<void> {
  const child = await requireAttachedSession(childSessionId, deps)
  if (child.attachedChild.status === "running" || child.attachedChild.status === "closed") return
  await deps.updateSession(childSessionId, {
    attachedChild: {
      ...child.attachedChild,
      status: "running",
      updatedAt: deps.now(),
    },
  })
}

export async function completeAttachedSession(
  childSessionId: string,
  result: { summary: string; messageId?: string },
  deps: AttachedSessionDeps = defaultAttachedSessionDeps()
): Promise<void> {
  const child = await requireAttachedSession(childSessionId, deps)
  const summary = result.summary.trim()
  if (!summary) throw new Error("An attached-session result cannot be empty")
  const completedAt = deps.now()
  await deps.updateSession(childSessionId, {
    attachedChild: {
      ...child.attachedChild,
      status: "completed",
      updatedAt: completedAt,
      result: {
        summary,
        ...(result.messageId ? { messageId: result.messageId } : {}),
        completedAt,
      },
    },
  })
}

export async function interruptAttachedSession(
  childSessionId: string,
  ownerSessionId: string,
  deps: AttachedSessionDeps = defaultAttachedSessionDeps()
): Promise<void> {
  const child = await requireAttachedSession(childSessionId, deps)
  if (child.attachedChild.lifecycleOwnerSessionId !== ownerSessionId) {
    throw new Error(`Session ${ownerSessionId} does not own attached session ${childSessionId}`)
  }
  if (child.attachedChild.status === "completed" || child.attachedChild.status === "closed") return
  await deps.updateSession(childSessionId, {
    attachedChild: {
      ...child.attachedChild,
      status: "interrupted",
      updatedAt: deps.now(),
    },
  })
}

export async function closeAttachedSession(
  childSessionId: string,
  ownerSessionId: string,
  deps: AttachedSessionDeps = defaultAttachedSessionDeps()
): Promise<void> {
  const child = await requireAttachedSession(childSessionId, deps)
  if (child.attachedChild.lifecycleOwnerSessionId !== ownerSessionId) {
    throw new Error(`Session ${ownerSessionId} does not own attached session ${childSessionId}`)
  }

  const seen = new Set<string>()
  const closeOwnedSubtree = async (
    session: ChatSession & { attachedChild: AttachedChildSession }
  ): Promise<void> => {
    if (seen.has(session.id)) return
    seen.add(session.id)
    const descendants = await deps.listChildren(session.id)
    for (const descendant of descendants) {
      if (
        descendant.attachedChild?.parentSessionId === session.id &&
        descendant.attachedChild.lifecycleOwnerSessionId === session.id
      ) {
        await closeOwnedSubtree(descendant as ChatSession & { attachedChild: AttachedChildSession })
      }
    }
    await deps.updateSession(session.id, {
      attachedChild: {
        ...session.attachedChild,
        status: "closed",
        updatedAt: deps.now(),
      },
    })
  }

  await closeOwnedSubtree(child)
}

export async function listAttachedSessions(parentSessionId: string): Promise<ChatSession[]> {
  return (await listSessionBranches(parentSessionId)).filter(
    (session) =>
      session.attachedChild?.parentSessionId === parentSessionId &&
      session.importTombstonedAt === undefined &&
      session.archivedAt === undefined
  )
}
