/**
 * Plugin Session API Implementation
 *
 * Provides session management capabilities to plugins.
 */

import { useSessionStore } from "@/stores/chat/session-store"
import { db, messageRepository } from "@/lib/db"

/**
 * Coerce a possibly-Date / possibly-number value into a millisecond
 * timestamp suitable for arithmetic comparison. Returns `null` when the
 * value is something else (e.g., a string title) so the caller can fall
 * back to lexical sort.
 */
function toComparableTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  return null
}
import type {
  PluginSessionAPI,
  SessionFilter,
  MessageQueryOptions,
  SendMessageOptions,
} from "@/types/plugin/plugin"
import type { Session, UIMessage } from "@/types"
import { createPluginSystemLogger } from "../core/logger"
import { nanoid } from "nanoid"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"

/**
 * Create the Session API for a plugin
 */
export function createSessionAPI(pluginId: string): PluginSessionAPI {
  // Store unsubscribe functions for cleanup
  const subscriptions = new Map<string, () => void>()
  const logger = createPluginSystemLogger(pluginId)

  const api: PluginSessionAPI = {
    getCurrentSession: () => {
      const store = useSessionStore.getState()
      if (!store.activeSessionId) return null
      return store.sessions.find((s) => s.id === store.activeSessionId) || null
    },

    getCurrentSessionId: () => {
      return useSessionStore.getState().activeSessionId
    },

    getSession: async (id: string) => {
      const store = useSessionStore.getState()
      return store.sessions.find((s) => s.id === id) || null
    },

    createSession: async (options = {}) => {
      const store = useSessionStore.getState()
      const session = store.createSession(options)
      logger.info(`Created session: ${session.id}`)
      return session
    },

    updateSession: async (id: string, updates) => {
      const store = useSessionStore.getState()
      store.updateSession(id, updates)
      logger.info(`Updated session: ${id}`)
    },

    switchSession: async (id: string) => {
      const store = useSessionStore.getState()
      store.setActiveSession(id)
      logger.info(`Switched to session: ${id}`)
    },

    deleteSession: async (id: string) => {
      const store = useSessionStore.getState()
      store.deleteSession(id)
      // Also delete messages from database
      try {
        await messageRepository.deleteBySessionId(id)
      } catch (error) {
        logger.error(`Failed to delete messages for session ${id}:`, error)
      }
      logger.info(`Deleted session: ${id}`)
    },

    listSessions: async (filter?: SessionFilter) => {
      const store = useSessionStore.getState()
      let sessions = [...store.sessions]

      if (filter) {
        // Apply filters
        if (filter.projectId) {
          sessions = sessions.filter((s) => s.projectId === filter.projectId)
        }
        if (filter.mode) {
          sessions = sessions.filter((s) => s.mode === filter.mode)
        }
        if (filter.createdAfter) {
          sessions = sessions.filter((s) => new Date(s.createdAt) > filter.createdAfter!)
        }
        if (filter.createdBefore) {
          sessions = sessions.filter((s) => new Date(s.createdAt) < filter.createdBefore!)
        }

        // Sort
        if (filter.sortBy) {
          const sortKey = filter.sortBy
          sessions.sort((a, b) => {
            const aVal = a[sortKey] as unknown
            const bVal = b[sortKey] as unknown
            const aTime = toComparableTime(aVal)
            const bTime = toComparableTime(bVal)
            if (aTime !== null && bTime !== null) {
              return filter.sortOrder === "desc" ? bTime - aTime : aTime - bTime
            }
            if (typeof aVal === "string" && typeof bVal === "string") {
              return filter.sortOrder === "desc"
                ? bVal.localeCompare(aVal)
                : aVal.localeCompare(bVal)
            }
            return 0
          })
        }

        // Pagination
        if (filter.offset) {
          sessions = sessions.slice(filter.offset)
        }
        if (filter.limit) {
          sessions = sessions.slice(0, filter.limit)
        }
      }

      return sessions
    },

    getMessages: async (sessionId: string, options?: MessageQueryOptions) => {
      try {
        let messages: UIMessage[]

        if (options?.branchId) {
          messages = await messageRepository.getBySessionIdAndBranch(sessionId, options.branchId)
        } else {
          messages = await messageRepository.getBySessionId(sessionId)
        }

        // Apply pagination
        if (options?.offset) {
          messages = messages.slice(options.offset)
        }
        if (options?.limit) {
          messages = messages.slice(0, options.limit)
        }

        return messages
      } catch (error) {
        logger.error("Failed to get messages:", error)
        return []
      }
    },

    addMessage: async (sessionId: string, content: string, options?: SendMessageOptions) => {
      const newMessage: UIMessage = {
        id: nanoid(),
        role: options?.role || "user",
        content,
        createdAt: new Date(),
        attachments: options?.attachments?.map((a) => ({
          id: nanoid(),
          name: a.name,
          type: "file" as const,
          mimeType: a.mimeType || "text/plain",
          url: a.url || "",
          size: 0,
        })),
      }

      try {
        await messageRepository.create(sessionId, newMessage)
        logger.info(`Added message to session: ${sessionId}`)
        return newMessage
      } catch (error) {
        logger.error("Failed to add message:", error)
        throw error
      }
    },

    updateMessage: async (sessionId: string, messageId: string, updates: Partial<UIMessage>) => {
      try {
        await messageRepository.update(messageId, updates)
        logger.info(`Updated message: ${messageId}`)
      } catch (error) {
        logger.error("Failed to update message:", error)
        throw error
      }
    },

    deleteMessage: async (sessionId: string, messageId: string) => {
      try {
        await messageRepository.delete(messageId)

        logger.info(`Deleted message: ${messageId}`)
      } catch (error) {
        logger.error("Failed to delete message:", error)
        throw error
      }
    },

    onSessionChange: (handler: (session: Session | null) => void) => {
      const unsubscribe = useSessionStore.subscribe((state) => {
        const session = state.activeSessionId
          ? state.sessions.find((s) => s.id === state.activeSessionId) || null
          : null
        handler(session)
      })

      const subId = nanoid()
      subscriptions.set(subId, unsubscribe)

      return () => {
        unsubscribe()
        subscriptions.delete(subId)
      }
    },

    onMessagesChange: (sessionId: string, handler: (messages: UIMessage[]) => void) => {
      let active = true
      const table = db.messages

      const emitMessages = async () => {
        if (!active) return

        try {
          const messages = await messageRepository.getBySessionId(sessionId)
          handler(messages)
        } catch (error) {
          logger.error("Error checking messages:", error)
        }
      }

      const handleCreate = (_primaryKey: string, obj: { sessionId?: string }) => {
        if (!active) return
        if (obj.sessionId === sessionId) {
          void emitMessages()
        }
      }

      const handleUpdate = (_mods: unknown, _primaryKey: string, obj: { sessionId?: string }) => {
        if (!active) return
        if (obj?.sessionId === sessionId) {
          void emitMessages()
        }
      }

      const handleDelete = (_primaryKey: string, obj: { sessionId?: string }) => {
        if (!active) return
        if (obj?.sessionId === sessionId) {
          void emitMessages()
        }
      }

      void emitMessages()
      table.hook("creating", handleCreate)
      table.hook("updating", handleUpdate)
      table.hook("deleting", handleDelete)

      return () => {
        active = false
        table.hook("creating").unsubscribe(handleCreate)
        table.hook("updating").unsubscribe(handleUpdate)
        table.hook("deleting").unsubscribe(handleDelete)
      }
    },

    getSessionStats: async (sessionId: string) => {
      try {
        const messages = await messageRepository.getBySessionId(sessionId)
        const store = useSessionStore.getState()
        const session = store.sessions.find((s) => s.id === sessionId)

        const userMessages = messages.filter((m) => m.role === "user")
        const assistantMessages = messages.filter((m) => m.role === "assistant")

        let totalTokens = 0
        const totalResponseTime = 0
        const responseCount = 0

        for (const msg of assistantMessages) {
          if (msg.tokens) {
            totalTokens += msg.tokens.total || 0
          }
          // Response time would need to be tracked separately
        }

        const attachmentCount = messages.reduce((count, msg) => {
          return count + (msg.attachments?.length || 0)
        }, 0)

        return {
          messageCount: messages.length,
          userMessageCount: userMessages.length,
          assistantMessageCount: assistantMessages.length,
          totalTokens,
          averageResponseTime: responseCount > 0 ? totalResponseTime / responseCount : 0,
          branchCount: session?.branches?.length || 0,
          attachmentCount,
        }
      } catch (error) {
        logger.error("Failed to get session stats:", error)
        return {
          messageCount: 0,
          userMessageCount: 0,
          assistantMessageCount: 0,
          totalTokens: 0,
          averageResponseTime: 0,
          branchCount: 0,
          attachmentCount: 0,
        }
      }
    },
  }

  return createGuardedAPI(pluginId, api, {
    getCurrentSession: "session:read",
    getCurrentSessionId: "session:read",
    getSession: "session:read",
    listSessions: "session:read",
    getMessages: "session:read",
    onSessionChange: "session:read",
    onMessagesChange: "session:read",
    getSessionStats: "session:read",
    createSession: "session:write",
    updateSession: "session:write",
    switchSession: "session:write",
    deleteSession: "session:write",
    addMessage: "session:write",
    updateMessage: "session:write",
    deleteMessage: "session:write",
  })
}
