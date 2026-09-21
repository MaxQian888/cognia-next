import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"

import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import type { ExternalAgentMessage } from "@/types/agent/external-agent"
import { hasNoLeakingExternalAgentPromptInput } from "@/lib/ai/agent/external/outbound-prompt-pii"
import { materializeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { serializeHandoffParts } from "@/lib/chat/export-handoff-to-cli"
import { getSession, updateSession } from "@/lib/db/sessions"
import { buildHandoffContext } from "./handoff-context"
import { listMessages } from "@/lib/db/messages"
import {
  dispatchConversationToCodexApp,
  type CodexAppDispatchMessage,
} from "@/lib/native/codex-app-dispatch"
import { openUrl } from "@/lib/native/opener"

export type CodexAppDispatchErrorCode =
  "NO_CWD" | "NO_USER_MESSAGE" | "UNTRANSFERABLE_CONTENT" | "TARGET_NOT_FOUND" | "PII_BLOCKED"

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
    includeToolDetails: true,
    losslessDetails: true,
  })
  if (!content) return null
  const timestampMs = messageTimestamp(message)
  return {
    role: message.role,
    content,
    attachments: message.parts.flatMap((part) => {
      const raw = part as unknown as Record<string, unknown>
      return ["file", "image"].includes(String(raw.type)) &&
        typeof raw.url === "string" &&
        raw.url.startsWith("data:")
        ? [{ dataUrl: raw.url, filename: String(raw.filename ?? "attachment") }]
        : []
    }),
    ...(timestampMs === undefined ? {} : { timestampMs }),
  }
}

async function createAndOpenSnapshot(session: ChatSession): Promise<{ threadId: string }> {
  const [storedMessages, cwd] = await Promise.all([
    listMessages(session.id),
    resolveEffectiveCwdForSession(session),
  ])
  if (!cwd?.trim()) throw new CodexAppDispatchError("NO_CWD")

  const messages = await Promise.all(
    storedMessages.map((message) => materializeMessageMedia(message))
  )
  const projection = buildHandoffContext(messages, { maxChars: 64 * 1024 * 1024 })
  if (
    projection.losses.some((loss) => loss.kind !== "attachment") ||
    projection.omittedMessageIds.length
  ) {
    throw new CodexAppDispatchError("UNTRANSFERABLE_CONTENT")
  }
  if (
    messages.some((message) =>
      message.parts.some((part) => {
        const raw = part as unknown as Record<string, unknown>
        return (
          ["file", "image"].includes(String(raw.type)) &&
          (typeof raw.url !== "string" || !/^(data:.*;base64,|https?:|file:|\/)/.test(raw.url))
        )
      })
    )
  )
    throw new CodexAppDispatchError("UNTRANSFERABLE_CONTENT")

  const snapshotMessages = messages
    .map(toDispatchMessage)
    .filter((message): message is CodexAppDispatchMessage => message !== null)
  if (!snapshotMessages.some((message) => message.role === "user")) {
    throw new CodexAppDispatchError("NO_USER_MESSAGE")
  }

  const imported = session.importCanonicalState
  const historicalState = imported
    ? {
        tasks: imported.tasks,
        plans: imported.plans,
        goals: imported.goals,
        checkpoints: imported.checkpoints,
        interAgentMessages: imported.interAgentMessages,
      }
    : undefined
  const historicalInstructions = [
    session.systemPrompt,
    ...messages
      .filter((message) => message.role === "system")
      .map((message) =>
        serializeHandoffParts(message.parts, {
          includeReasoningDetails: false,
          losslessDetails: true,
        })
      ),
  ].filter((text): text is string => !!text?.trim())
  if (historicalState || historicalInstructions.length) {
    const reference = buildHandoffContext([], {
      maxChars: 64 * 1024 * 1024,
      state: { taskState: historicalState, historicalInstructions },
    })
    if (reference.losses.length) throw new CodexAppDispatchError("UNTRANSFERABLE_CONTENT")
    snapshotMessages.unshift({ role: "user", content: reference.text, attachments: [] })
  }
  for (const [index, snapshot] of snapshotMessages.entries()) {
    const content: ExternalAgentMessage["content"] = [{ type: "text", text: snapshot.content }]
    for (const attachment of snapshot.attachments ?? []) {
      const separator = attachment.dataUrl.indexOf(",")
      const header = attachment.dataUrl.slice(0, separator)
      content.push({
        type: "file",
        path: attachment.filename,
        encoding: "base64",
        mimeType: header.slice(5).replace(/;base64$/, ""),
        content: attachment.dataUrl.slice(separator + 1),
      })
    }
    if (
      !hasNoLeakingExternalAgentPromptInput(
        { id: `handoff-${index}`, role: snapshot.role, content, timestamp: new Date(0) },
        { title: session.title, cwd }
      )
    ) {
      throw new CodexAppDispatchError("PII_BLOCKED")
    }
  }

  const result = await dispatchConversationToCodexApp({
    sourceSessionId: session.id,
    title: session.title.trim() || "Cognia conversation",
    cwd: cwd.trim(),
    messages: snapshotMessages,
  })
  await updateSession(session.id, {
    codexHandoff: {
      threadId: result.threadId,
      deepLink: result.deepLink,
      exportedAt: Date.now(),
      ...(session.codexHandoff?.threadId === result.threadId &&
      session.codexHandoff.returnedSessionId
        ? { returnedSessionId: session.codexHandoff.returnedSessionId }
        : {}),
    },
  })
  await openUrl(result.deepLink)
  return { threadId: result.threadId }
}

/**
 * Create a role-preserving snapshot in Codex App. Simultaneous clicks for one
 * Cognia session share one import; native durable receipts reuse unchanged snapshots.
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

/** Reuse the canonical importer; never merge two independently advanced histories. */
export async function returnSessionFromCodexApp(session: ChatSession): Promise<string> {
  const binding = session.codexHandoff
  if (!binding) throw new CodexAppDispatchError("TARGET_NOT_FOUND")
  const { resolveScanInput, listSessionsForSource, importSessions } =
    await import("@/lib/session-import")
  const { importedSessionId } = await import("@/lib/session-import/to-parts")
  const input = await resolveScanInput()
  const summaries = await listSessionsForSource("codex", input)
  const target = summaries.find((summary) => summary.ref.originalSessionId === binding.threadId)
  if (!target) throw new CodexAppDispatchError("TARGET_NOT_FOUND")
  const imported = await importSessions([target.ref], input, session.projectId)
  if (imported.failures?.length)
    throw new Error(imported.failures.map((failure) => failure.message).join("; "))
  const returnedSessionId = importedSessionId("codex", binding.threadId)
  if (!(await getSession(returnedSessionId))) throw new CodexAppDispatchError("TARGET_NOT_FOUND")
  await updateSession(returnedSessionId, { parentSessionId: session.id })
  await updateSession(session.id, { codexHandoff: { ...binding, returnedSessionId } })
  return returnedSessionId
}
