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
import {
  registerChatMiddleware,
  unregisterChatMiddleware,
  type ChatMiddlewareRegistration as _Reg,
} from "@/lib/claude/chat-middleware/registry"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import type { PluginSelectionRef } from "@/types/artifact/artifact"
import { registerLinkMatcher } from "./link-matchers"
import type { PluginChatAPI } from "@cognia/plugin-contract/lib/plugin/api/chat-api"
export type {
  PluginChatAPI,
  PluginChatSelectionInput,
  PluginComposerIntentOptions,
} from "@cognia/plugin-contract/lib/plugin/api/chat-api"

const ownedByPlugin = new Map<string, Set<string>>()

export function createChatAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean = () => false
): PluginChatAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    registerLinkMatcher(def) {
      if (!hasPermission("extension:ui")) {
        throw new Error("Permission denied: extension:ui is required")
      }
      return registerLinkMatcher(pluginId, def)
    },

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
      // The target has to EXIST. `appendMessageToSession` routes an unknown id
      // through `sliceForId`, which seeds an empty slice rather than failing —
      // so a typo would quietly create a phantom conversation holding the
      // plugin's message, and the plugin would get an id back as if it had
      // landed somewhere real.
      if (sessionId !== state.activeSessionId && !state.sessions[sessionId]) {
        logger.warn(`[chat] appendMessagePart: unknown session ${sessionId}`)
        return null
      }
      const id = `plugin-${pluginId}-${nanoid(8)}`
      // Addressed write. The previous call was `state.appendMessage(msg)`, which
      // ignores `sessionId` entirely and always writes to whichever session has
      // focus — so a plugin appending to a background session landed its message
      // in the one the user was reading. Switching the active session to make
      // the write land would be worse still: it moves the user's view as a side
      // effect of a plugin's write.
      state.appendMessageToSession(sessionId, {
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
