/**
 * Plugin Chat API — middleware registration, plus the composer write surface.
 *
 * Lets a plugin register an around-style middleware via `ctx.chat.use(...)`.
 * Each middleware can inspect/transform the outgoing chat request, short-
 * circuit it, and post-process the response. Safety net (timeout, error
 * isolation, 3-strike circuit breaker) is enforced by the runner in
 * `lib/claude/chat-middleware/runner.ts`.
 *
 * Auto-cleanup on plugin disable is wired through
 * `clearChatMiddlewaresForPlugin(pluginId)` from the registry module.
 *
 * ADR-0026 §4 §A.
 */

import { nanoid } from "nanoid"
import { createPluginSystemLogger } from "../core/logger"
import type { ChatMiddleware } from "@/types/plugin/plugin-chat-middleware"
import {
  registerChatMiddleware,
  unregisterChatMiddleware,
  type ChatMiddlewareRegistration as _Reg,
} from "@/lib/claude/chat-middleware/registry"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import type { PluginSelectionRef } from "@/types/artifact/artifact"

/**
 * What a plugin stages as chat context.
 *
 * `kind` and `pluginId` are absent on purpose: the host stamps both, so a
 * plugin cannot stage a selection attributed to another plugin or forge one of
 * the host's own kinds.
 */
export interface PluginChatSelectionInput {
  /** Chip label and prompt heading subject. */
  title: string
  /** The text itself — what the assistant actually sees. */
  snapshot: string
  /** The user's note on it, if the plugin collected one. */
  comment?: string
  /** What the plugin calls this thing, e.g. `"wiki page"`. English. */
  sourceLabel: string
  /** The plugin's own address for the selection, echoed back on jump-to-source. */
  ref?: string
  /** Workspace lines the excerpt came from. */
  citations?: Array<{ path: string; startLine?: number; endLine?: number }>
}

export interface PluginComposerIntentOptions {
  /** Composer to address. Defaults to the active session. */
  sessionId?: string
  /**
   * Send immediately instead of leaving the text for the user to edit.
   *
   * Opt-in, and it stays opt-in: a plugin that stages a prompt is suggesting a
   * turn, and turning that into "the app just messaged the model on your
   * behalf" is a different act the author has to ask for.
   */
  autoSend?: boolean
}

export interface PluginChatAPI {
  /**
   * Register a middleware. Returns a disposer the plugin can call to
   * unregister explicitly (the host also unregisters automatically on
   * plugin disable). The optional `id` argument lets the plugin pin a
   * stable id for telemetry and the circuit-breaker key — when omitted a
   * random id is generated.
   */
  use(
    fn: ChatMiddleware,
    options?: { id?: string; priority?: number; timeoutMs?: number }
  ): () => void

  /**
   * Stage a selection as context for the user's next message.
   *
   * The composer already renders one chip per staged ref, folds them into the
   * outgoing prompt and clears them after send — this puts a plugin's own
   * surfaces on that same pipeline instead of asking every plugin to paste
   * text into the composer and hope the formatting survives.
   *
   * Requires `session:write`.
   */
  addContextSelection(selection: PluginChatSelectionInput): void

  /**
   * Append text to a composer's draft, leaving the caret after it.
   *
   * Additive, never destructive: whatever the user had typed stays. Requires
   * `session:write`.
   */
  appendToComposer(text: string, options?: { sessionId?: string }): void

  /**
   * Stage a prompt for a composer to pick up, optionally sending it.
   *
   * Returns the candidate id the composer consumes, so a plugin that stages
   * twice can tell which one was taken. Requires `session:write`.
   */
  stageIntent(prompt: string, options?: PluginComposerIntentOptions): string

  /**
   * Append a system message carrying a custom part into a transcript.
   *
   * This is the other half of `defineMessageRenderer`. A plugin can register a
   * renderer for a part type it invents, but until now nothing could put a
   * message carrying that part into the conversation — so the renderer only
   * ever drew if the HOST happened to emit the part, which for a
   * plugin-invented type it never does. The OCR plugin worked around it by
   * writing to the chat store directly.
   *
   * The part is passed through untouched; the host owns only the envelope
   * (id, `system` role, ordering). Returns the message id, or `null` when
   * there is no session to append to. Requires `session:write`.
   */
  appendMessagePart(part: unknown, options?: { sessionId?: string }): string | null
}

const ownedByPlugin = new Map<string, Set<string>>()

export function createChatAPI(pluginId: string): PluginChatAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    use(fn, options) {
      const middlewareId = options?.id ?? `m_${nanoid(8)}`
      const owned = ownedByPlugin.get(pluginId) ?? new Set<string>()
      const fullId = `${pluginId}:${middlewareId}`
      if (owned.has(fullId)) {
        throw new Error(
          `[chat-api] plugin ${pluginId} already registered middleware "${middlewareId}"`
        )
      }
      const dispose = registerChatMiddleware({
        pluginId,
        middlewareId,
        fn,
        priority: options?.priority,
        timeoutMs: options?.timeoutMs,
      })
      owned.add(fullId)
      ownedByPlugin.set(pluginId, owned)
      logger.info(`[chat] registered middleware "${fullId}"`)
      return () => {
        if (!owned.has(fullId)) return
        dispose()
        owned.delete(fullId)
        if (owned.size === 0) ownedByPlugin.delete(pluginId)
        logger.info(`[chat] unregistered middleware "${fullId}"`)
      }
    },

    addContextSelection(selection) {
      const ref: PluginSelectionRef = {
        kind: "plugin",
        pluginId,
        title: selection.title,
        snapshot: selection.snapshot,
        comment: selection.comment ?? "",
        sourceLabel: selection.sourceLabel,
        ...(selection.ref ? { ref: selection.ref } : {}),
        ...(selection.citations?.length ? { citations: selection.citations } : {}),
      }
      useChatStore.getState().addContextSelection(ref)
      logger.info(`[chat] staged a ${selection.sourceLabel} selection`)
    },

    appendToComposer(text, options) {
      if (!text) return
      void dispatchAppend(text, options?.sessionId)
    },

    stageIntent(prompt, options) {
      const sessionId = options?.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) {
        throw new Error("[chat-api] no session to stage an intent for")
      }
      const candidateId = `plugin_${pluginId}_${nanoid(8)}`
      useComposerIntentStore.getState().stage(sessionId, {
        candidateId,
        prompt,
        ...(options?.autoSend ? { autoSend: true } : {}),
      })
      logger.info(`[chat] staged an intent for session ${sessionId}`)
      return candidateId
    },

    appendMessagePart(part, options) {
      const state = useChatStore.getState()
      const sessionId = options?.sessionId ?? state.activeSessionId
      if (!sessionId) {
        logger.warn("[chat] appendMessagePart: no session to append to")
        return null
      }
      const id = `plugin-${pluginId}-${nanoid(8)}`
      state.appendMessage({
        id,
        role: "system",
        parts: [part],
      } as never)
      logger.info(`[chat] appended a message part to session ${sessionId}`)
      return id
    },
  }
}

/**
 * Append through the composer's window-event seam.
 *
 * Imported lazily because `components/chat/composer` is the whole composer
 * module: a static import would drag it — and everything it renders — into
 * every import graph that merely builds a plugin context, including headless.
 */
async function dispatchAppend(text: string, sessionId?: string): Promise<void> {
  const { dispatchComposerAppend } = await import("@/components/chat/composer")
  dispatchComposerAppend({ text, ...(sessionId ? { sessionId } : {}) })
}

/** Plugin-disable hook — drop every middleware the plugin owns. */
export function clearChatMiddlewaresForPluginContext(pluginId: string): void {
  const owned = ownedByPlugin.get(pluginId)
  if (!owned) return
  for (const fullId of owned) {
    unregisterChatMiddleware(fullId)
  }
  ownedByPlugin.delete(pluginId)
}

/** Test-only. */
export function __resetChatApiForTesting(): void {
  ownedByPlugin.clear()
}
