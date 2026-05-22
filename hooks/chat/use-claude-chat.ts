"use client"

import { startTransition, useCallback, useEffect, useRef } from "react"
import type { UnlistenFn } from "@tauri-apps/api/event"
import {
  applySdkEvent,
  contentPreview,
  makeUserMessage,
  mergeTwinSourcesIntoLastAssistant,
} from "@/lib/claude/adapter"
import { attemptRoutingFallback } from "@/lib/claude/routing-fallback"
import { applyPlanModeBridge } from "@/lib/agent/plan-mode-bridge"
import {
  approveTool,
  closeSession,
  deleteMessage,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
} from "@/lib/claude/ipc"
import { detectPlatform } from "@/hooks/use-platform"

// ADR-0020 W3 — the chat-modal session grant only ever applies to the
// three plugin MCP tools that the `cognia-computer-use` plugin
// contributes. Hard-coded as a tight const so a typo in a future tool
// rename won't silently flip permissions on the wrong tool.
const COMPUTER_USE_PLUGIN_TOOL_NAMES = new Set([
  "computer_use",
  "bash",
  "text_editor",
  // The sidecar surfaces them through the cognia-plugin-tools MCP, so
  // the prefixed form lands on the chat side. Match both bare and
  // prefixed in case the upstream renames the bridge.
  "mcp__cognia-plugin-tools__computer_use",
  "mcp__cognia-plugin-tools__bash",
  "mcp__cognia-plugin-tools__text_editor",
])

function isComputerUsePluginToolName(name: string): boolean {
  return COMPUTER_USE_PLUGIN_TOOL_NAMES.has(name)
}
import { listMessages, persistMessages, truncateAfter } from "@/lib/db/messages"
import { getDb } from "@/lib/db/schema"
import { getSession, setSdkSessionId, touchSession, updateSession } from "@/lib/db/sessions"
import { recordResultUsage } from "@/lib/db/session-usage"
import { bumpUnread } from "@/lib/db/session-state"
import { resolveSendOptions } from "@/lib/claude/build-options"
import {
  dispatchChatError as dispatchPluginChatError,
  dispatchUserPromptSubmit as dispatchPluginUserPromptSubmit,
} from "@/lib/claude/adapter-hooks"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
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
import { useAgentRuntimeStore } from "@/stores/agent"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { isTauri } from "@/lib/tauri"
import { mark as perfMark } from "@/lib/perf"
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
  /**
   * Pending branch tag set by `regenerate` and consumed by the first
   * assistant message that arrives afterward. Keyed by sessionId so a regen
   * fired from another session doesn't taint the active turn.
   */
  const pendingBranchTagRef = useRef<Map<string, { groupId: string; index: number }>>(new Map())

  // Subscribe to sidecar events once.
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false

    onClaudeMessage((evt) => {
      void handleEvent(evt, activeRef, allowListRef, pendingBranchTagRef).catch((err) => {
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
    async (
      content: SendContent,
      opts?: SendOptions,
      callOptions?: {
        /** Skip the optimistic user-message append. Used by `regenerate` so we
         *  don't duplicate the user turn when re-issuing the SDK request. */
        skipUserAppend?: boolean
      }
    ) => {
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

      // ephemeralSkillIds were consumed by buildSendOptions; clear them so
      // the next turn starts with a fresh attachment set.
      if ((useChatStore.getState().ephemeralSkillIds ?? []).length > 0) {
        useChatStore.getState().clearEphemeralSkillIds?.()
      }

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

      // Plugin opt-in — fire `onUserPromptSubmit` before the network call.
      // Block / modify / proceed semantics:
      //   • "block" — surface the plugin's reason as the chat error and bail.
      //   • "modify" — when the plugin returns `modifiedPrompt` and the
      //     content is plain text, replace it; multimodal content is left
      //     alone (mod APIs only describe text).
      //   • "modify" with `additionalContext` — fold into the appendSystemPrompt
      //     slot so the SDK passes it through as a system-prompt extension.
      // Errors bubble up as `proceed` (adapter-hooks swallows internally).
      let effectiveContent: SendContent = content
      const promptText =
        typeof content === "string"
          ? content
          : ((content.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "")
      const promptDecision = await dispatchPluginUserPromptSubmit(
        promptText,
        sessionId,
        // Cast — the dispatcher's structural shape accepts any subset.
        {} as never
      )
      if (promptDecision.action === "block") {
        store.getState().setError(promptDecision.reason ?? "A plugin blocked this prompt.")
        return
      }
      if (promptDecision.action === "modify") {
        if (typeof promptDecision.modifiedPrompt === "string") {
          if (typeof content === "string") {
            effectiveContent = promptDecision.modifiedPrompt
          } else {
            // Replace the first text block with the modified prompt and keep
            // the rest of the content (attachments, etc.) intact.
            effectiveContent = content.map((block) => {
              if (block.type === "text") {
                return { ...block, text: promptDecision.modifiedPrompt as string } as typeof block
              }
              return block
            })
          }
        }
        const additionalContext = (promptDecision as { additionalContext?: string })
          .additionalContext
        if (typeof additionalContext === "string" && additionalContext.trim()) {
          const existing = sendOptions.appendSystemPrompt?.trim() ?? ""
          sendOptions = {
            ...sendOptions,
            appendSystemPrompt: existing
              ? `${existing}\n\n${additionalContext}`
              : additionalContext,
          }
        }
      }

      // Capture text from the (possibly plugin-modified) effective content.
      const effectiveText =
        typeof effectiveContent === "string"
          ? effectiveContent
          : ((effectiveContent.find((b) => b.type === "text") as { text?: string } | undefined)
              ?.text ?? "")

      // Optimistic user-message append. Skipped during regenerate so the
      // existing user anchor stays the single source of truth for that turn.
      const previousMessages = useChatStore.getState().messages
      const userMsg = makeUserMessage(effectiveContent)
      const next = callOptions?.skipUserAppend ? previousMessages : [...previousMessages, userMsg]
      if (!callOptions?.skipUserAppend) {
        store.getState().replaceMessages(next)
      }
      store.getState().setStatus("streaming")
      perfMark("stream-start")
      store.getState().setError(null)
      lastUserContentRef.current.set(sessionId, effectiveContent)

      // ── External agent branch ──────────────────────────────────────────
      // When the user selected "external" runtime in the composer toolbar,
      // dispatch to the external agent manager instead of the Claude SDK
      // sidecar. The optimistic user-message stays in the store so the
      // composer reflects the send immediately; the assistant reply is
      // appended from the manager result when it lands.
      const agentRuntime = useAgentRuntimeStore.getState().runtime
      if (agentRuntime === "external") {
        const extAgentId = useAgentRuntimeStore.getState().externalAgentId
        if (!extAgentId) {
          store.getState().replaceMessages(previousMessages)
          store.getState().setError("No external agent selected")
          store.getState().setStatus("idle")
          return
        }

        try {
          await persistMessages(sessionId, next)
          await touchSession(sessionId)
          if (session && (session.title === "New chat" || !session.title)) {
            const preview = contentPreview(effectiveContent, 40)
            if (preview) await updateSession(sessionId, { title: preview })
          }

          const { executeOnExternalAgent } = await import("@/lib/ai/agent/external/manager")
          const { applyExternalAgentEventToParts } =
            await import("@/lib/ai/agent/external/event-to-parts")

          // Pre-allocate the assistant message so partial deltas land in it
          // without flickering the chat list. Parts start empty and grow as
          // ExternalAgentEvents arrive via the onEvent callback below.
          const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          let assistantParts: UIMessage["parts"] = [] as unknown as UIMessage["parts"]
          const baseList = useChatStore.getState().messages

          const writeAssistant = () => {
            const assistantMsg: UIMessage = {
              id: assistantId,
              role: "assistant",
              parts: assistantParts,
            }
            store.getState().replaceMessages([...baseList, assistantMsg])
          }

          const result = await executeOnExternalAgent(effectiveText, {
            agentId: extAgentId,
            onEvent: (event) => {
              const nextParts = applyExternalAgentEventToParts(assistantParts, event)
              if (nextParts !== assistantParts) {
                assistantParts = nextParts as UIMessage["parts"]
                writeAssistant()
              }
            },
          })

          if (!result) {
            store.getState().replaceMessages(previousMessages)
            store.getState().setError("No external agent available for this request")
            store.getState().setStatus("idle")
            return
          }

          if (!result.success) {
            store.getState().replaceMessages(previousMessages)
            store.getState().setError(result.error ?? "External agent execution failed")
            store.getState().setStatus("idle")
            return
          }

          // When the event stream never produced a text track (some agents
          // only emit a single final response), fall back to the assembled
          // finalResponse to make sure the user always sees something.
          if (
            assistantParts.length === 0 ||
            !assistantParts.some(
              (p) => (p as { type?: string }).type === "text" && (p as { text?: string }).text
            )
          ) {
            assistantParts = [
              ...(assistantParts as unknown as Array<Record<string, unknown>>),
              { type: "text", text: result.finalResponse, state: "done" },
            ] as unknown as UIMessage["parts"]
            writeAssistant()
          }

          const finalMessages = useChatStore.getState().messages
          await persistMessages(sessionId, finalMessages)
          store.getState().setStatus("idle")
        } catch (err) {
          store.getState().replaceMessages(previousMessages)
          const error = err instanceof Error ? err : new Error(String(err))
          store.getState().setError(error.message)
          store.getState().setStatus("idle")
          dispatchPluginChatError(sessionId, error)
        }
        return
      }
      // ── End external agent branch ──────────────────────────────────────

      try {
        await persistMessages(sessionId, next)
        await touchSession(sessionId)
        // If the session has no title yet, derive one from the first prompt.
        if (session && (session.title === "New chat" || !session.title)) {
          const preview = contentPreview(effectiveContent, 40)
          if (preview) await updateSession(sessionId, { title: preview })
        }
        await sendPrompt(sessionId, effectiveContent, sendOptions)
        // Cache the post-routing send so a transient `session_ended.error`
        // can re-issue the turn against the next entry in the alias's
        // fallback chain. Set even when there is no alias — the retry
        // path checks `aliasResolution.fallbackEntries.length` before
        // doing anything.
        useChatStore.getState().setLastSend(sessionId, {
          content: effectiveContent,
          options: sendOptions,
          attemptIndex: 0,
        })
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        store.getState().setError(error.message)
        // Notify plugins; fire-and-forget — host already surfaced the error.
        dispatchPluginChatError(sessionId, error)
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
      // ADR-0020 W3 — remember the operator's Allow for any computer-use
      // plugin tool so subsequent turns inside this session skip the chat
      // modal when the active character's `chatConsentMode ===
      // "session-grant"`. The Rust ConsentBroker keeps its own
      // per-tuple session grants for defence-in-depth; this store only
      // governs the chat-side prompt cadence. Recording unconditionally
      // is safe because the SEND-side check
      // (`applyComputerUseTools`) consults `chatConsentMode` before
      // honouring a grant.
      if (decision === "allow" || decision === "allow_always") {
        if (isComputerUsePluginToolName(approval.toolName)) {
          const { recordSessionGrant } = await import("@/lib/claude/computer-use-session-grants")
          recordSessionGrant(approval.sessionId, approval.toolName)
        }
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
   *
   * On mobile (Capacitor), the truncate also fans out to the desktop's
   * Dexie via the companion RPC bridge so the authoritative store stays
   * in lockstep with the phone. On desktop / web the local `truncateAfter`
   * is the only mutation.
   */
  const editAndResend = useCallback(
    async (messageId: string, newContent: SendContent) => {
      const sessionId = useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (detectPlatform() === "mobile") {
        await mirrorTruncateToDesktop(sessionId, messageId)
      }
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
    // Existing assistant siblings — every assistant message after the anchor
    // belongs to the same branch group. We retain them with branchGroupId
    // metadata so the user can switch back via the BranchNavigator.
    const groupId = anchor.id
    const existingSiblings = messages.slice(lastUserIdx + 1).filter((m) => m.role === "assistant")
    const taggedSiblings = existingSiblings.map((m, i) => {
      const meta = (m as { metadata?: Record<string, unknown> }).metadata ?? {}
      // Preserve any prior branchGroupId — only stamp if missing.
      const stampedGroup =
        typeof meta.branchGroupId === "string" ? (meta.branchGroupId as string) : groupId
      const stampedIndex = typeof meta.branchIndex === "number" ? (meta.branchIndex as number) : i
      return {
        ...m,
        metadata: { ...meta, branchGroupId: stampedGroup, branchIndex: stampedIndex },
      } as typeof m
    })

    // Persist the tagged siblings (and untouched prefix) before the new send.
    const prefix = messages.slice(0, lastUserIdx + 1)
    const merged = [...prefix, ...taggedSiblings]
    store.getState().replaceMessages(merged)
    await persistMessages(sessionId, merged)

    // Stash the next-branch tag in a ref so handleEvent can stamp the
    // freshly-arrived assistant message with branchGroupId + the next index.
    const nextIndex = existingSiblings.length
    pendingBranchTagRef.current.set(sessionId, { groupId, index: nextIndex })

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
    await send(content, undefined, { skipUserAppend: true })
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

/**
 * Mobile-only: mirror a `truncateAfter(sessionId, anchorId, { inclusive: true })`
 * to the desktop's Dexie by calling `message_delete` for the anchor + every
 * subsequent message. Reads from the local Dexie to compute the set, which
 * is fine because mobile sync keeps the local store in lockstep before
 * any edit operation.
 *
 * Errors from individual deletes are logged but never thrown — the local
 * truncate (and subsequent send) is the load-bearing path; a desktop write
 * failure surfaces later through sync rather than blocking the user.
 */
async function mirrorTruncateToDesktop(sessionId: string, anchorMessageId: string): Promise<void> {
  try {
    const db = getDb()
    const anchor = await db.messages.get(anchorMessageId)
    if (!anchor || anchor.sessionId !== sessionId) return
    const ids = await db.messages
      .where("[sessionId+createdAt]")
      .between([sessionId, anchor.createdAt], [sessionId, Number.MAX_SAFE_INTEGER])
      .primaryKeys()
    for (const rawId of ids) {
      const id = rawId as string
      try {
        await deleteMessage(sessionId, id)
      } catch (err) {
        console.warn("mirrorTruncateToDesktop: deleteMessage failed", { id, err })
      }
    }
  } catch (err) {
    console.warn("mirrorTruncateToDesktop failed", err)
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

  // Per-message ephemeral skills attached via the composer's SkillPicker.
  // These are unioned with character.skillIds in resolveSendOptions and
  // cleared after the send dispatches.
  const ephemeralSkillIds = useChatStore.getState().ephemeralSkillIds ?? []

  return resolveSendOptions({
    session,
    appSettings,
    referencedPaths,
    twinDeps: twinHandshake,
    twinUserMessage: twinHandshake ? userMessage : undefined,
    ephemeralSkillIds,
  })
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
  allowListRef: React.MutableRefObject<string[]>,
  pendingBranchTagRef: React.MutableRefObject<Map<string, { groupId: string; index: number }>>
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
          // P4 routing-fallback: re-issue against the next entry in the
          // chain when the cached send carried fallbackEntries and the
          // error class is transient. `attemptRoutingFallback` returns
          // `true` when a retry was scheduled — in that case suppress
          // the error toast so the UI stays in `streaming`.
          const retried = await attemptRoutingFallback(evt.sessionId, evt.error)
          if (!retried) {
            useChatStore.getState().setError(evt.error)
            useChatStore.getState().clearLastSend(evt.sessionId)
          }
        } else {
          useChatStore.getState().setStatus("idle")
          useChatStore.getState().clearLastSend(evt.sessionId)
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

      const {
        messages: appliedMessages,
        turnComplete,
        result: sdkResult,
      } = applySdkEvent(current, env.event)

      // If `regenerate` queued a branch tag for this session, stamp it onto
      // the freshly-appended assistant message. The tag is one-shot — once
      // consumed we drop it so subsequent assistant turns are untouched.
      let nextMessages = appliedMessages
      const pendingTag = pendingBranchTagRef.current.get(sessionId)
      if (pendingTag && appliedMessages !== current && appliedMessages.length > current.length) {
        const lastIdx = appliedMessages.length - 1
        const last = appliedMessages[lastIdx]
        if (last?.role === "assistant") {
          const meta = (last as { metadata?: Record<string, unknown> }).metadata ?? {}
          const stamped = {
            ...last,
            metadata: {
              ...meta,
              branchGroupId: pendingTag.groupId,
              branchIndex: pendingTag.index,
            },
          }
          nextMessages = [...appliedMessages.slice(0, lastIdx), stamped]
          pendingBranchTagRef.current.delete(sessionId)
          if (isActive) {
            useChatStore.getState().setActiveBranch(pendingTag.groupId, stamped.id)
          }
        }
      }

      // Plan-mode → tasks bridge: forward TodoWrite / TaskCreate / TaskUpdate
      // / TaskList / ExitPlanMode tool_use blocks to the agent-team store so
      // the workspace tasks panel surfaces the agent's own plan. Wrapped so
      // a bridge throw never breaks the chat event loop.
      try {
        const session = await getSession(sessionId)
        applyPlanModeBridge(env.event, sessionId, session?.teamId)
      } catch (err) {
        console.warn("planModeBridge failed", err)
      }

      // Twin sources injection — runs once per turn at `turnComplete`. The
      // `applyTwinContext` runtime data was stashed onto sendOptions.twinContext
      // during `resolveSendOptions`; we read it back from the lastSend cache
      // (the same place routing-fallback uses) and merge twin + style sources
      // onto the last assistant message's SourcesPart.
      if (turnComplete) {
        const last = useChatStore.getState().lastSendBySession[sessionId]
        const twinCtx = last?.options.twinContext
        if (twinCtx) {
          const withTwin = mergeTwinSourcesIntoLastAssistant(nextMessages, twinCtx)
          if (withTwin !== nextMessages) {
            nextMessages = withTwin
          }
        }
      }

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

      // Persist per-turn usage + cost. Runs for every result event regardless
      // of `isActive` so background sessions still accumulate cost. Idempotent
      // on (messageId) — re-applying the same result overwrites the row.
      if (sdkResult) {
        const lastAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
        if (lastAssistant) {
          const session = await getSession(sessionId).catch(() => undefined)
          await recordResultUsage({
            sessionId,
            messageId: lastAssistant.id,
            characterId: session?.characterId,
            model: session?.model,
            result: sdkResult,
          }).catch((err) => {
            console.warn("recordResultUsage failed", err)
          })
        }
      }

      if (turnComplete && isActive) {
        // Don't immediately flip to idle if approvals are still pending; the
        // store helper handles the precedence.
        const { pendingApprovals } = useChatStore.getState()
        if (pendingApprovals.length === 0) {
          perfMark("stream-end")
          // Wrap the streaming→idle flip in `startTransition` so the heavy
          // commit it triggers — unmounting Streamdown, mounting react-markdown
          // + sanitize, and lazy-loading any Mermaid/Math/Diff blocks via
          // next/dynamic — lands at transition priority. The user's scroll
          // and keyboard input remain interruptible during the swap.
          startTransition(() => {
            useChatStore.getState().setStatus("idle")
          })
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
