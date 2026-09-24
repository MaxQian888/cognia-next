import type { UIMessage } from "ai"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import type { ChatSession } from "@cognia/agent-config-types"

import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import type { ExternalAgentMessage } from "@/types/agent/external-agent"
import { hasNoLeakingExternalAgentPromptInput } from "@/lib/ai/agent/external/policy/outbound-prompt-pii"
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

/** Return immutable, content-addressed snapshots so continued histories never get overwritten. */
export async function returnSessionFromCodexApp(session: ChatSession): Promise<string> {
  const source = (await getSession(session.id)) ?? session
  const binding = source.codexHandoff
  if (!binding) throw new CodexAppDispatchError("TARGET_NOT_FOUND")
  const { resolveScanInput, listSessionsForSource, parseSessions } =
    await import("@/lib/session-import")
  const { importedSessionId } = await import("@/lib/session-import/to-parts")
  const { applyImported } = await import("@/lib/data/import-registry")
  const input = await resolveScanInput()
  const summaries = await listSessionsForSource("codex", input)
  const target = summaries.find((summary) => summary.ref.originalSessionId === binding.threadId)
  if (!target) throw new CodexAppDispatchError("TARGET_NOT_FOUND")
  const conversations = await parseSessions([target.ref], input, source.projectId)
  const originalRootId = importedSessionId("codex", binding.threadId)
  if (!conversations.some((conversation) => conversation.session.id === originalRootId)) {
    throw new CodexAppDispatchError("TARGET_NOT_FOUND")
  }

  // Hash source evidence, not local decorations or parse-time fallback dates.
  // A retry after local continuation resolves the same snapshot; an updated
  // Codex transcript receives a new identity and preserves both branches.
  const digest = bytesToHex(
    sha256(
      JSON.stringify({
        sourceSessionId: source.id,
        conversations: conversations
          .map((conversation) => ({
            id: conversation.session.id,
            title: conversation.session.title,
            workingDir: conversation.session.workingDir,
            model: conversation.session.model,
            state: conversation.session.importCanonicalState,
            relation: conversation.session.importRelation,
            lifecycle: conversation.session.importLifecycle,
            messages: conversation.messages.map((message) => ({
              id: message.id,
              role: message.role,
              parts: message.parts,
              metadata: message.metadata,
            })),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      })
    )
  )
  const ids = new Map(
    conversations.map((conversation) => [
      conversation.session.id,
      `${conversation.session.id}:handoff:${digest}`,
    ])
  )
  const returnedSessionId = ids.get(originalRootId)!
  if (!(await getSession(returnedSessionId))) {
    const messageIds = new Map(
      conversations.flatMap((conversation) =>
        conversation.messages.map(
          (message, index) =>
            [message.id, `${ids.get(conversation.session.id)!}:m${index}`] as const
        )
      )
    )
    const remapReferences = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(remapReferences)
      if (!value || typeof value !== "object") return value
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          typeof nested === "string" &&
          ["sessionId", "parentSessionId", "lifecycleOwnerSessionId", "subagentSessionId"].includes(
            key
          )
            ? (ids.get(nested) ?? nested)
            : typeof nested === "string" &&
                ["messageId", "parentMessageId", "anchorMessageId"].includes(key)
              ? (messageIds.get(nested) ?? nested)
              : remapReferences(nested),
        ])
      )
    }
    const snapshots = conversations.map((conversation) => {
      const originalId = conversation.session.id
      const id = ids.get(originalId)!
      const surface = conversation.session.surfaceBinding
      return {
        ...conversation,
        session: {
          ...conversation.session,
          id,
          importFrozen: true,
          importOwnership: "cognia-owned" as const,
          importRuntimeBinding: undefined,
          sdkSessionId: undefined,
          externalAgentSession: undefined,
          parentSessionId:
            originalId === originalRootId
              ? source.id
              : (ids.get(conversation.session.parentSessionId ?? "") ??
                conversation.session.parentSessionId),
          importGraphRootId: returnedSessionId,
          ...(conversation.session.attachedChild
            ? {
                attachedChild: remapReferences(conversation.session.attachedChild) as NonNullable<
                  ChatSession["attachedChild"]
                >,
              }
            : {}),
          ...(surface?.kind === "session"
            ? {
                surfaceBinding: {
                  ...surface,
                  sessionId: ids.get(surface.sessionId) ?? surface.sessionId,
                },
              }
            : {}),
        },
        messages: conversation.messages.map((message, index) => ({
          ...message,
          id: `${id}:m${index}`,
          sessionId: id,
          parts: remapReferences(message.parts) as typeof message.parts,
          metadata: remapReferences(message.metadata) as typeof message.metadata,
        })),
      }
    })
    await applyImported(snapshots)
  }
  const persisted = await getSession(returnedSessionId)
  if (persisted?.id !== returnedSessionId) throw new CodexAppDispatchError("TARGET_NOT_FOUND")
  // The comparison and patch share a transaction: an export racing this scan
  // cannot replace its binding between our read and write.
  const { getDb } = await import("@/lib/db/schema")
  const db = getDb()
  await db.transaction("rw", db.sessions, async () => {
    const currentSource = await db.sessions.get(source.id)
    if (
      currentSource?.codexHandoff?.threadId === binding.threadId &&
      currentSource.codexHandoff.exportedAt === binding.exportedAt
    ) {
      await updateSession(source.id, {
        codexHandoff: { ...currentSource.codexHandoff, returnedSessionId },
      })
    }
  })
  return returnedSessionId
}
