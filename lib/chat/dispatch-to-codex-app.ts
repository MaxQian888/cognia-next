import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"

import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import { serializeHandoffParts } from "@/lib/chat/export-handoff-to-cli"
import { listMessages } from "@/lib/db/messages"
import {
  dispatchConversationToCodexApp,
  type CodexAppDispatchMessage,
} from "@/lib/native/codex-app-dispatch"
import { openUrl } from "@/lib/native/opener"

export type CodexAppDispatchErrorCode = "NO_CWD" | "NO_USER_MESSAGE"

export class CodexAppDispatchError extends Error {
  constructor(public readonly code: CodexAppDispatchErrorCode) {
    super(code)
    this.name = "CodexAppDispatchError"
  }
}

const inFlightDispatches = new Map<string, Promise<{ threadId: string }>>()

function messageTimestamp(message: UIMessage): number | undefined {
  const value = (message.metadata as Record<string, unknown> | undefined)?.createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toDispatchMessage(message: UIMessage): CodexAppDispatchMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null
  const content = serializeHandoffParts(message.parts, {
    includeReasoningDetails: false,
    includeToolDetails: false,
  })
  if (!content) return null
  const timestampMs = messageTimestamp(message)
  return {
    role: message.role,
    content,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  }
}

async function createAndOpenSnapshot(session: ChatSession): Promise<{ threadId: string }> {
  const [messages, cwd] = await Promise.all([
    listMessages(session.id),
    resolveEffectiveCwdForSession(session),
  ])
  if (!cwd?.trim()) throw new CodexAppDispatchError("NO_CWD")

  const snapshotMessages = messages
    .map(toDispatchMessage)
    .filter((message): message is CodexAppDispatchMessage => message !== null)
  if (!snapshotMessages.some((message) => message.role === "user")) {
    throw new CodexAppDispatchError("NO_USER_MESSAGE")
  }

  const result = await dispatchConversationToCodexApp({
    title: session.title.trim() || "Cognia conversation",
    cwd: cwd.trim(),
    messages: snapshotMessages,
  })
  await openUrl(result.deepLink)
  return { threadId: result.threadId }
}

/**
 * Create a role-preserving snapshot in Codex App. Simultaneous clicks for one
 * Cognia session share one import; a later click intentionally creates a new task.
 */
export function dispatchSessionToCodexApp(session: ChatSession): Promise<{ threadId: string }> {
  const existing = inFlightDispatches.get(session.id)
  if (existing) return existing

  const dispatch = createAndOpenSnapshot(session)
  inFlightDispatches.set(session.id, dispatch)
  const clear = () => {
    if (inFlightDispatches.get(session.id) === dispatch) inFlightDispatches.delete(session.id)
  }
  void dispatch.then(clear, clear)
  return dispatch
}
