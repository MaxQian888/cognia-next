import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { hasNoLeakingPii } from "@cognia/redact"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { buildHandoffContext } from "@/lib/chat/handoff-context"
import { listMessages } from "@/lib/db/messages"
import { getSession, updateSession } from "@/lib/db/sessions"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import { sessionStatusOf } from "@/hooks/chat/steer-runtime"
import { extractAssistantText } from "@/hooks/chat/claude-chat-turn-tasks"
import { enableProjectCoordination } from "./user-actions"
import { continueAsProjectRefusal, type ContinueAsProjectRefusal } from "./continue-eligibility"

/**
 * "Continue as project" (ADR-0204): a conversation that grew into more than
 * one task becomes the first thread of its workspace's project, and the
 * coordinator picks up from it.
 *
 * The conversation is not copied. It is re-parented under the coordinator as
 * a completed thread — its transcript, branch and worktree stay where they
 * are, `read_thread_report` reaches it, and a message to it continues it. The
 * coordinator's first turn carries the conversation's handoff projection (the
 * same one a runtime switch uses: whole messages, honest markers for what was
 * omitted or not transferred) and is asked to plan what remains.
 */

/** The coordinator is told where things stand, not handed the whole history. */
export const CONTINUE_CONTEXT_MAX_CHARS = 12_000
export const CONTINUE_RESULT_MAX_CHARS = 1_500

export type ContinueAsProjectResult =
  | { kind: "continued"; coordinator: ChatSession; thread: ChatSession; seeded: boolean }
  | { kind: "refused"; reason: ContinueAsProjectRefusal }

export interface ContinueAsProjectDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  updateSession: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
  listMessages: (sessionId: string) => Promise<UIMessage[]>
  statusOf: (sessionId: string) => ChatStatus
  enable: (projectId: string, coordinatorTitle: string) => Promise<ChatSession>
  send: (sessionId: string, text: string) => boolean
  gate: (text: string) => boolean
  now: () => number
}

function defaultDeps(): ContinueAsProjectDeps {
  return {
    getSession,
    updateSession,
    listMessages,
    statusOf: sessionStatusOf,
    enable: (projectId, title) => enableProjectCoordination(projectId, title),
    send: sendChatMessage,
    gate: hasNoLeakingPii,
    now: Date.now,
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

/** The coordinator's first message. The context is left out when it would trip the PII gate. */
export function renderContinueSeed(input: {
  title: string
  threadId: string
  context: string | null
}): string {
  return [
    `Continue the conversation "${input.title}" as this project.`,
    `It is now thread ${input.threadId} of the project, marked completed. read_thread_report reads its latest result, and message_thread continues it.`,
    "Review where the work stands, then propose threads for what remains with propose_threads.",
    input.context
      ? `Context from that conversation:\n\n${input.context}`
      : "Its content is not included here because it contains personal details or secrets; read it with read_thread_report.",
  ].join("\n\n")
}

export async function continueAsProject(
  input: { sessionId: string; coordinatorTitle: string },
  deps: ContinueAsProjectDeps = defaultDeps()
): Promise<ContinueAsProjectResult> {
  const session = await deps.getSession(input.sessionId)
  const refusal = continueAsProjectRefusal(session, deps.statusOf(input.sessionId))
  if (refusal || !session?.projectId) return { kind: "refused", reason: refusal ?? "missing" }

  const coordinator = await deps.enable(session.projectId, input.coordinatorTitle)
  const messages = await deps.listMessages(session.id)
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
  const now = deps.now()
  const title = session.title?.trim() || session.id
  // The result feeds the coordinator's status digest on every turn, so it is
  // only recorded when the send path's PII gate would let it through.
  const result = lastAssistant
    ? truncate(extractAssistantText(lastAssistant), CONTINUE_RESULT_MAX_CHARS)
    : ""

  const patch: Partial<ChatSession> = {
    projectRole: "thread",
    parentSessionId: coordinator.id,
    projectThread: {
      coordinatorSessionId: coordinator.id,
      brief: title,
      proposedBy: "user",
    },
    attachedChild: {
      parentSessionId: coordinator.id,
      lifecycleOwnerSessionId: coordinator.id,
      context: { mode: "none" },
      workspace: "independent",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      ...(lastAssistant && result && deps.gate(result)
        ? { result: { summary: result, messageId: lastAssistant.id, completedAt: now } }
        : {}),
    },
  }
  await deps.updateSession(session.id, patch)

  const context = buildHandoffContext(messages, { maxChars: CONTINUE_CONTEXT_MAX_CHARS }).text
  // Most to least: with the context, without it, and without the title — the
  // send path refuses a prompt carrying an email, key or token outright.
  const seed =
    [
      renderContinueSeed({ title, threadId: session.id, context: context || null }),
      renderContinueSeed({ title, threadId: session.id, context: null }),
    ].find((text) => deps.gate(text)) ??
    renderContinueSeed({ title: session.id, threadId: session.id, context: null })
  return {
    kind: "continued",
    coordinator,
    thread: { ...session, ...patch },
    seeded: deps.send(coordinator.id, seed),
  }
}
