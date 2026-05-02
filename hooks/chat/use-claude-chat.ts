"use client"

import { useCallback, useEffect, useRef } from "react"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { applySdkEvent, contentPreview, makeUserMessage } from "@/lib/claude/adapter"
import {
  approveTool,
  closeSession,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
} from "@/lib/claude/ipc"
import { listMessages, persistMessages, truncateAfter } from "@/lib/db/messages"
import { getSession, setSdkSessionId, touchSession, updateSession } from "@/lib/db/sessions"
import { bumpUnread } from "@/lib/db/session-state"
import { resolveSendOptions } from "@/lib/claude/build-options"
import type {
  ApprovalDecision,
  ChatSession,
  ClaudeEvent,
  PendingApproval,
  SDKEventEnvelope,
  SendContent,
  SendOptions,
} from "@/lib/claude/types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { isTauri } from "@/lib/tauri"
import type { UIMessage } from "ai"

/**
 * Pull plain assistant text out of a UIMessage's parts. Used to feed the
 * artifact detector; only the rendered text content is meaningful — tool
 * calls and reasoning blocks are ignored.
 */
function extractAssistantText(message: UIMessage | undefined): string {
  if (!message || message.role !== "assistant") return ""
  return message.parts
    .map((part) => {
      const p = part as { type?: string; text?: string }
      return p.type === "text" && typeof p.text === "string" ? p.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * Wires the Claude sidecar IPC into the React store. Mount this hook once at
 * the top of the chat page; do not invoke it per-message.
 */
export function useClaudeChat() {
  const store = useChatStore
  // The active session id is captured per-render via a ref so the long-lived
  // event handler always sees the freshest value without resubscribing.
  const activeRef = useRef<string | null>(null)
  useEffect(() => {
    const unsub = useChatStore.subscribe((s) => {
      activeRef.current = s.activeSessionId
    })
    activeRef.current = useChatStore.getState().activeSessionId
    return unsub
  }, [])

  // Always-allow tool list — also kept fresh via ref.
  const allowListRef = useRef<string[]>([])
  useEffect(() => {
    const unsub = useSettingsStore.subscribe((s) => {
      allowListRef.current = s.settings?.alwaysAllowTools ?? []
    })
    allowListRef.current = useSettingsStore.getState().settings?.alwaysAllowTools ?? []
    return unsub
  }, [])

  // Track the last user content per session so we can regenerate without
  // re-deriving from message parts (which lose the original SendContent shape
  // when they include attachments).
  const lastUserContentRef = useRef<Map<string, SendContent>>(new Map())

  // Subscribe to sidecar events once.
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false

    onClaudeMessage((evt) => {
      void handleEvent(evt, activeRef, allowListRef).catch((err) => {
        console.error("handleEvent failed", err)
      })
    })
      .then((u) => {
        if (cancelled) u()
        else unlisten = u
      })
      .catch((err) => {
        console.error("listen claude events failed", err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  /**
   * Send a user prompt to the active session.
   *
   * `content` can be a plain string (the common case) or an array of
   * multimodal content blocks (text + image), to support attachments.
   */
  const send = useCallback(
    async (content: SendContent, opts?: SendOptions) => {
      const sessionId = useChatStore.getState().activeSessionId
      if (!sessionId) {
        useChatStore.getState().setError("No session selected")
        return
      }
      if (typeof content === "string" && !content.trim()) return
      if (Array.isArray(content) && content.length === 0) return

      const session = await getSession(sessionId)
      // Extract a plain-text version of the user message for twin RAG. The
      // multimodal path (array of blocks) finds the first text block; if
      // none we leave userMessage undefined and the runtime falls back to
      // the no-context path.
      const userMessageText =
        typeof content === "string"
          ? content
          : (content.find((b) => b.type === "text") as { text?: string } | undefined)?.text
      let sendOptions = opts ?? (await buildSendOptions(session, userMessageText))

      // Apply per-command frontmatter overrides set by the composer when the
      // user picked a custom slash command. Cleared after merge so the next
      // turn doesn't inherit them.
      const pending = useChatStore.getState().pendingCommandOverrides
      if (pending) {
        sendOptions = {
          ...sendOptions,
          model: pending.model ?? sendOptions.model,
          allowedTools: pending.allowedTools
            ? Array.from(new Set([...(sendOptions.allowedTools ?? []), ...pending.allowedTools]))
            : sendOptions.allowedTools,
          additionalDirectories: pending.paths
            ? Array.from(new Set([...(sendOptions.additionalDirectories ?? []), ...pending.paths]))
            : sendOptions.additionalDirectories,
        }
        useChatStore.getState().setPendingCommandOverrides(null)
      }

      // Optimistic user-message append.
      const userMsg = makeUserMessage(content)
      const next = [...useChatStore.getState().messages, userMsg]
      store.getState().replaceMessages(next)
      store.getState().setStatus("streaming")
      store.getState().setError(null)
      lastUserContentRef.current.set(sessionId, content)

      try {
        await persistMessages(sessionId, next)
        await touchSession(sessionId)
        // If the session has no title yet, derive one from the first prompt.
        if (session && (session.title === "New chat" || !session.title)) {
          const preview = contentPreview(content, 40)
          if (preview) await updateSession(sessionId, { title: preview })
        }
        await sendPrompt(sessionId, content, sendOptions)
      } catch (err) {
        store.getState().setError(err instanceof Error ? err.message : String(err))
      }
    },
    [store]
  )

  const stop = useCallback(async () => {
    const sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) return
    try {
      await interruptSession(sessionId)
      store.getState().setStatus("idle")
    } catch (err) {
      console.error("interrupt failed", err)
    }
  }, [store])

  const respondToApproval = useCallback(
    async (approval: PendingApproval, decision: ApprovalDecision): Promise<void> => {
      // Persist always-allow choice.
      if (decision === "allow_always") {
        await useSettingsStore.getState().toggleAlwaysAllow(approval.toolName, true)
      }
      try {
        await approveTool(
          approval.sessionId,
          approval.requestId,
          decision === "allow_always" ? "allow" : decision
        )
      } finally {
        store.getState().clearApproval(approval.requestId)
      }
    },
    [store]
  )

  const close = useCallback(async (sessionId: string) => {
    try {
      await closeSession(sessionId)
    } catch (err) {
      console.error("close session failed", err)
    }
  }, [])

  /**
   * Truncate the message log starting from `messageId` (inclusive) and resend
   * the supplied content. Used for "edit and resend" on a user message.
   */
  const editAndResend = useCallback(
    async (messageId: string, newContent: SendContent) => {
      const sessionId = useChatStore.getState().activeSessionId
      if (!sessionId) return
      // Drop everything from this message onward, including the message itself.
      await truncateAfter(sessionId, messageId, { inclusive: true })
      // Re-hydrate the store from Dexie so the optimistic append in send() is
      // applied to the correct base.
      const remaining = await listMessages(sessionId)
      store.getState().replaceMessages(remaining)
      await send(newContent)
    },
    [send, store]
  )

  /**
   * Re-issue the most recent user turn. Drops the assistant reply that
   * followed it (and anything after) and resends the original content.
   */
  const regenerate = useCallback(async () => {
    const sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) return

    const messages = useChatStore.getState().messages
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return

    const anchor = messages[lastUserIdx]
    // Remove the user message AND everything after it; we'll re-add it in send().
    await truncateAfter(sessionId, anchor.id, { inclusive: true })
    const remaining = await listMessages(sessionId)
    store.getState().replaceMessages(remaining)

    // Prefer the original SendContent if we have it (preserves attachments);
    // fall back to reconstructing from text parts.
    const cached = lastUserContentRef.current.get(sessionId)
    const content: SendContent =
      cached ??
      anchor.parts
        .filter((p): p is { type: "text"; text: string } => {
          const t = (p as { type?: string }).type
          return t === "text"
        })
        .map((p) => p.text)
        .join("")
    await send(content)
  }, [send, store])

  return {
    send,
    stop,
    respondToApproval,
    close,
    editAndResend,
    regenerate,
  }
}

async function buildSendOptions(
  session: ChatSession | null | undefined,
  userMessage?: string
): Promise<SendOptions> {
  const appSettings = useSettingsStore.getState().settings
  // The composer keeps @-referenced files/folders in the chat store. Hand
  // them to resolveSendOptions so each turn announces the directories the
  // SDK's Read tool may need.
  const referencedPaths = useChatStore
    .getState()
    .referencedPaths.map((r) => ({ absolute: r.absolute, isDir: r.isDir }))

  // Twin runtime injection: when the user has populated the runtime config
  // (vector store + embedding API key) and the message is a plain string,
  // hand resolveSendOptions the deps so it can call applyTwinContext for
  // any twin-bound character. resolveSendOptions itself decides whether to
  // run the injection based on `character.twinId`.
  const twinHandshake = userMessage?.trim() ? await tryBuildTwinDeps() : undefined

  return resolveSendOptions({
    session,
    appSettings,
    referencedPaths,
    twinDeps: twinHandshake,
    twinUserMessage: twinHandshake ? userMessage : undefined,
  })
}

/**
 * Best-effort twin deps loader. Pulls runtime settings + builds a vector
 * store client when the config is complete. Returns `undefined` (so the
 * resolver short-circuits) on any incomplete state — callers don't need
 * to know which field is missing.
 */
async function tryBuildTwinDeps(): Promise<
  Parameters<typeof resolveSendOptions>[0]["twinDeps"] | undefined
> {
  try {
    const { getTwinRuntimeSettings } = await import("@/lib/db/twin-runtime-settings")
    const settings = await getTwinRuntimeSettings()
    if (!settings.workerEnabled) return undefined
    if (!settings.embedding.apiKey) return undefined

    const { createVectorStore } = await import("@/lib/vector/store")
    const storage = settings.storage
    const embedding = {
      provider: settings.embedding.provider,
      model: settings.embedding.model,
      dimensions: undefined,
    }
    const apiKey = settings.embedding.apiKey

    type StoreConfig = Parameters<typeof createVectorStore>[0]
    let storeConfig: StoreConfig | null = null
    switch (storage.vectorBackend) {
      case "qdrant":
        if (storage.qdrant?.url) {
          storeConfig = {
            provider: "qdrant",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            qdrantUrl: storage.qdrant.url,
            qdrantApiKey: storage.qdrant.apiKey,
          }
        }
        break
      case "pinecone":
        if (storage.pinecone?.apiKey && storage.pinecone.indexName) {
          storeConfig = {
            provider: "pinecone",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            pineconeApiKey: storage.pinecone.apiKey,
            pineconeIndexName: storage.pinecone.indexName,
            pineconeNamespace: storage.pinecone.namespace,
          }
        }
        break
      case "weaviate":
        if (storage.weaviate?.url) {
          storeConfig = {
            provider: "weaviate",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            weaviateUrl: storage.weaviate.url,
            weaviateApiKey: storage.weaviate.apiKey,
          }
        }
        break
      case "milvus":
        if (storage.milvus?.address) {
          storeConfig = {
            provider: "milvus",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            milvusAddress: storage.milvus.address,
            milvusToken: storage.milvus.token,
            milvusSsl: storage.milvus.ssl,
          }
        }
        break
      case "chroma":
        if (storage.chroma?.mode === "embedded" || storage.chroma?.serverUrl) {
          storeConfig = {
            provider: "chroma",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            chromaMode: storage.chroma?.mode,
            chromaServerUrl: storage.chroma?.serverUrl,
          }
        }
        break
      case "native":
        storeConfig = {
          provider: "native",
          embeddingConfig: embedding,
          embeddingApiKey: apiKey,
          native: {},
        }
        break
    }
    if (!storeConfig) return undefined

    const store = createVectorStore(storeConfig)
    return {
      store,
      embedding: settings.embedding,
      vectorBackend: settings.storage.vectorBackend,
    }
  } catch {
    return undefined
  }
}

/** Sub-session ids used by team chat embed `::char::` between the team
 * session id and the character id (see hooks/use-team-chat.ts). The direct
 * chat handler should ignore those — useTeamChat handles them. */
function isTeamSubSession(sessionId: string): boolean {
  return sessionId.includes("::char::")
}

async function handleEvent(
  evt: ClaudeEvent,
  activeRef: React.MutableRefObject<string | null>,
  allowListRef: React.MutableRefObject<string[]>
) {
  // Skip events for team sub-sessions outright — useTeamChat handles them.
  if (
    (evt.type === "event" ||
      evt.type === "session_ended" ||
      evt.type === "permission_request" ||
      evt.type === "sdk_session_id") &&
    typeof evt.sessionId === "string" &&
    isTeamSubSession(evt.sessionId)
  ) {
    return
  }
  switch (evt.type) {
    case "ready":
    case "log":
    case "sidecar_exited":
      return
    case "sdk_session_id": {
      // Persist the SDK conversation id so the next send can pass it as
      // `resumeSessionId` after a sidecar restart or app reload.
      await setSdkSessionId(evt.sessionId, evt.sdkSessionId).catch((err) => {
        console.error("setSdkSessionId failed", err)
      })
      return
    }
    case "session_ended": {
      const isActive = evt.sessionId === activeRef.current
      if (isActive) {
        if (evt.error) {
          useChatStore.getState().setError(evt.error)
        } else {
          useChatStore.getState().setStatus("idle")
        }
      }
      return
    }
    case "permission_request": {
      // Auto-approve if the user has previously allowed this tool.
      if (allowListRef.current.includes(evt.toolName)) {
        try {
          await approveTool(evt.sessionId, evt.requestId, "allow")
        } catch (err) {
          console.error("auto-approve failed", err)
        }
        return
      }
      const isActive = evt.sessionId === activeRef.current
      if (!isActive) {
        // For non-active sessions, default-deny rather than block silently.
        try {
          await approveTool(evt.sessionId, evt.requestId, "deny", "auto-denied: session not active")
        } catch (err) {
          console.error("non-active deny failed", err)
        }
        return
      }
      const approval: PendingApproval = {
        sessionId: evt.sessionId,
        requestId: evt.requestId,
        toolUseID: evt.toolUseID,
        toolName: evt.toolName,
        input: evt.input,
        title: evt.title,
        displayName: evt.displayName,
        description: evt.description,
        blockedPath: evt.blockedPath,
        decisionReason: evt.decisionReason,
      }
      useChatStore.getState().pushApproval(approval)
      return
    }
    case "event": {
      const env = evt as SDKEventEnvelope
      const sessionId = env.sessionId
      const isActive = sessionId === activeRef.current

      // Source of truth lives in Dexie. Load → apply → save → maybe sync store.
      const current = isActive ? useChatStore.getState().messages : await listMessages(sessionId)

      const { messages: nextMessages, turnComplete } = applySdkEvent(current, env.event)

      if (nextMessages !== current) {
        await persistMessages(sessionId, nextMessages)
        if (isActive) {
          useChatStore.getState().replaceMessages(nextMessages)
        } else if (
          nextMessages.length > current.length &&
          nextMessages[nextMessages.length - 1]?.role === "assistant"
        ) {
          // Background reply landed for a non-active session — bump the
          // unread count so the channel list shows a dot.
          await bumpUnread(sessionId).catch(() => {})
        }
      }

      if (turnComplete && isActive) {
        // Don't immediately flip to idle if approvals are still pending; the
        // store helper handles the precedence.
        const { pendingApprovals } = useChatStore.getState()
        if (pendingApprovals.length === 0) {
          useChatStore.getState().setStatus("idle")
        }

        // Auto-detect artifacts in the assistant turn that just sealed.
        // Honors the artifacts settings block; off by default for
        // power-users that flip the toggle.
        try {
          const settings = useSettingsStore.getState().settings
          const artifactsCfg = settings?.artifacts
          if (artifactsCfg?.autoCreate !== false) {
            const lastAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
            const text = extractAssistantText(lastAssistant)
            if (text && lastAssistant) {
              void useArtifactStore.getState().autoCreateFromContent({
                sessionId,
                messageId: lastAssistant.id,
                content: text,
                config: {
                  autoCreate: true,
                  minLines: artifactsCfg?.minLines,
                  enabledTypes: artifactsCfg?.enabledTypes,
                  showNotification: artifactsCfg?.showNotification !== false,
                },
              })
            }
          }
        } catch (err) {
          console.warn("autoCreateFromContent failed", err)
        }
      }
      return
    }
  }
}
