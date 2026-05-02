/**
 * Tests for Session Plugin API
 */

import { createSessionAPI } from "./session-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import type { Session, UIMessage } from "@/types"

// Mock session store
const mockSessions: Session[] = []
let mockActiveSessionId: string | null = null
const mockSubscribers: Array<(state: unknown) => void> = []

// Mock messages storage
const mockMessages: Record<string, UIMessage[]> = {}

const messageHooks = {
  creating: new Set<(primaryKey: string, obj: { sessionId?: string }) => void>(),
  updating: new Set<(mods: unknown, primaryKey: string, obj: { sessionId?: string }) => void>(),
  deleting: new Set<(primaryKey: string, obj: { sessionId?: string }) => void>(),
}

jest.mock("@/stores/chat/session-store", () => ({
  useSessionStore: {
    getState: jest.fn(() => ({
      sessions: mockSessions,
      activeSessionId: mockActiveSessionId,
      createSession: jest.fn((options = {}) => {
        const session: Session = {
          id: `session-${Date.now()}`,
          title: options.title || "New Session",
          mode: options.mode || "chat",
          provider: options.provider || "openai",
          model: options.model || "gpt-4o",
          createdAt: new Date(),
          updatedAt: new Date(),
          projectId: options.projectId,
        }
        mockSessions.push(session)
        mockMessages[session.id] = []
        return session
      }),
      updateSession: jest.fn((id, updates) => {
        const idx = mockSessions.findIndex((s) => s.id === id)
        if (idx >= 0) {
          Object.assign(mockSessions[idx], updates, { updatedAt: new Date() })
        }
      }),
      setActiveSession: jest.fn((id) => {
        mockActiveSessionId = id
      }),
      deleteSession: jest.fn((id) => {
        const idx = mockSessions.findIndex((s) => s.id === id)
        if (idx >= 0) mockSessions.splice(idx, 1)
        delete mockMessages[id]
      }),
    })),
    subscribe: jest.fn((callback) => {
      mockSubscribers.push(callback)
      return () => {
        const idx = mockSubscribers.indexOf(callback)
        if (idx >= 0) mockSubscribers.splice(idx, 1)
      }
    }),
  },
}))

jest.mock("@/lib/db", () => ({
  db: {
    messages: {
      hook: (type: "creating" | "updating" | "deleting", fn?: unknown) => {
        if (fn) {
          messageHooks[type].add(fn as never)
          return fn
        }
        return {
          unsubscribe: (handler: unknown) => {
            messageHooks[type].delete(handler as never)
          },
        }
      },
    },
  },
  messageRepository: {
    getBySessionId: jest.fn((sessionId) => {
      return Promise.resolve(mockMessages[sessionId] || [])
    }),
    getBySessionIdAndBranch: jest.fn((sessionId, _branchId) => {
      return Promise.resolve(mockMessages[sessionId] || [])
    }),
    create: jest.fn((sessionId, message) => {
      if (!mockMessages[sessionId]) mockMessages[sessionId] = []
      mockMessages[sessionId].push(message)
      return Promise.resolve(message)
    }),
    update: jest.fn((messageId, updates) => {
      for (const messages of Object.values(mockMessages)) {
        const msg = messages.find((m) => m.id === messageId)
        if (msg) {
          Object.assign(msg, updates)
          break
        }
      }
      return Promise.resolve()
    }),
    delete: jest.fn((messageId) => {
      for (const [sessionId, messages] of Object.entries(mockMessages)) {
        const idx = messages.findIndex((m) => m.id === messageId)
        if (idx >= 0) {
          mockMessages[sessionId].splice(idx, 1)
          break
        }
      }
      return Promise.resolve()
    }),
    deleteBySessionId: jest.fn((sessionId) => {
      delete mockMessages[sessionId]
      return Promise.resolve()
    }),
  },
}))

jest.mock("nanoid", () => ({
  nanoid: jest.fn(() => `id-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`),
}))

describe("Session API", () => {
  const testPluginId = "test-plugin"
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    resetPermissionGuard()
    guard = getPermissionGuard()
    guard.registerPlugin(testPluginId, ["session:read", "session:write"])
    mockSessions.length = 0
    mockActiveSessionId = null
    mockSubscribers.length = 0
    Object.keys(mockMessages).forEach((key) => delete mockMessages[key])
    messageHooks.creating.clear()
    messageHooks.updating.clear()
    messageHooks.deleting.clear()
  })

  describe("createSessionAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createSessionAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.getCurrentSession).toBe("function")
      expect(typeof api.getCurrentSessionId).toBe("function")
      expect(typeof api.getSession).toBe("function")
      expect(typeof api.createSession).toBe("function")
      expect(typeof api.updateSession).toBe("function")
      expect(typeof api.switchSession).toBe("function")
      expect(typeof api.deleteSession).toBe("function")
      expect(typeof api.listSessions).toBe("function")
      expect(typeof api.getMessages).toBe("function")
      expect(typeof api.addMessage).toBe("function")
      expect(typeof api.updateMessage).toBe("function")
      expect(typeof api.deleteMessage).toBe("function")
      expect(typeof api.onSessionChange).toBe("function")
      expect(typeof api.onMessagesChange).toBe("function")
      expect(typeof api.getSessionStats).toBe("function")
    })
  })

  describe("getCurrentSession / getCurrentSessionId", () => {
    it("should return null when no session is active", () => {
      const api = createSessionAPI(testPluginId)

      expect(api.getCurrentSession()).toBeNull()
      expect(api.getCurrentSessionId()).toBeNull()
    })

    it("should return current session when one is active", () => {
      const session: Session = {
        id: "sess-1",
        title: "Test Session",
        mode: "chat",
        provider: "openai",
        model: "gpt-4o",
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      mockSessions.push(session)
      mockActiveSessionId = "sess-1"

      const api = createSessionAPI(testPluginId)

      expect(api.getCurrentSession()?.id).toBe("sess-1")
      expect(api.getCurrentSessionId()).toBe("sess-1")
    })
  })

  describe("getSession", () => {
    it("should return session by ID", async () => {
      mockSessions.push({
        id: "sess-123",
        title: "Specific Session",
        mode: "chat",
        provider: "openai",
        model: "gpt-4o",
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const api = createSessionAPI(testPluginId)
      const result = await api.getSession("sess-123")

      expect(result?.title).toBe("Specific Session")
    })

    it("should return null for non-existent session", async () => {
      const api = createSessionAPI(testPluginId)
      const result = await api.getSession("non-existent")

      expect(result).toBeNull()
    })
  })

  describe("createSession", () => {
    it("should create a new session", async () => {
      const api = createSessionAPI(testPluginId)

      const session = await api.createSession({
        title: "New Session",
        mode: "agent",
      })

      expect(session.id).toBeDefined()
      expect(session.title).toBe("New Session")
      expect(mockSessions.length).toBe(1)
    })

    it("should create session with defaults", async () => {
      const api = createSessionAPI(testPluginId)

      const session = await api.createSession()

      expect(session.mode).toBe("chat")
    })
  })

  describe("updateSession", () => {
    it("should update an existing session", async () => {
      mockSessions.push({
        id: "update-sess",
        title: "Original",
        mode: "chat",
        provider: "openai",
        model: "gpt-4o",
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const api = createSessionAPI(testPluginId)
      await api.updateSession("update-sess", { title: "Updated Title" })

      expect(mockSessions[0].title).toBe("Updated Title")
    })
  })

  describe("switchSession", () => {
    it("should switch to a session", async () => {
      const api = createSessionAPI(testPluginId)
      await api.switchSession("sess-to-switch")

      expect(mockActiveSessionId).toBe("sess-to-switch")
    })
  })

  describe("deleteSession", () => {
    it("should delete a session", async () => {
      mockSessions.push({
        id: "delete-sess",
        title: "To Delete",
        mode: "chat",
        provider: "openai",
        model: "gpt-4o",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      mockMessages["delete-sess"] = [
        { id: "msg-1", role: "user", content: "Hello", createdAt: new Date() },
      ]

      const api = createSessionAPI(testPluginId)
      await api.deleteSession("delete-sess")

      expect(mockSessions.length).toBe(0)
      expect(mockMessages["delete-sess"]).toBeUndefined()
    })
  })

  describe("listSessions", () => {
    beforeEach(() => {
      const now = new Date()
      mockSessions.push(
        {
          id: "s1",
          title: "Session 1",
          mode: "chat",
          provider: "openai",
          model: "gpt-4o",
          createdAt: new Date(now.getTime() - 3000),
          updatedAt: now,
          projectId: "proj-1",
        },
        {
          id: "s2",
          title: "Session 2",
          mode: "agent",
          provider: "openai",
          model: "gpt-4o",
          createdAt: new Date(now.getTime() - 2000),
          updatedAt: now,
        },
        {
          id: "s3",
          title: "Session 3",
          mode: "chat",
          provider: "openai",
          model: "gpt-4o",
          createdAt: new Date(now.getTime() - 1000),
          updatedAt: now,
          projectId: "proj-1",
        }
      )
    })

    it("should list all sessions", async () => {
      const api = createSessionAPI(testPluginId)
      const result = await api.listSessions()

      expect(result.length).toBe(3)
    })

    it("should filter by projectId", async () => {
      const api = createSessionAPI(testPluginId)
      const result = await api.listSessions({ projectId: "proj-1" })

      expect(result.length).toBe(2)
    })

    it("should filter by mode", async () => {
      const api = createSessionAPI(testPluginId)
      const result = await api.listSessions({ mode: "agent" })

      expect(result.length).toBe(1)
      expect(result[0].mode).toBe("agent")
    })

    it("should apply pagination", async () => {
      const api = createSessionAPI(testPluginId)

      const limited = await api.listSessions({ limit: 2 })
      expect(limited.length).toBe(2)

      const offset = await api.listSessions({ offset: 1 })
      expect(offset.length).toBe(2)
    })
  })

  describe("Message operations", () => {
    const sessionId = "msg-test-session"

    beforeEach(() => {
      mockSessions.push({
        id: sessionId,
        title: "Message Test Session",
        mode: "chat",
        provider: "openai",
        model: "gpt-4o",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      mockMessages[sessionId] = [
        { id: "msg-1", role: "user", content: "Hello", createdAt: new Date() },
        { id: "msg-2", role: "assistant", content: "Hi there!", createdAt: new Date() },
      ]
    })

    it("should get messages", async () => {
      const api = createSessionAPI(testPluginId)
      const messages = await api.getMessages(sessionId)

      expect(messages.length).toBe(2)
    })

    it("should get messages with pagination", async () => {
      const api = createSessionAPI(testPluginId)
      const messages = await api.getMessages(sessionId, { limit: 1 })

      expect(messages.length).toBe(1)
    })

    it("should add a message", async () => {
      const api = createSessionAPI(testPluginId)
      const message = await api.addMessage(sessionId, "New message")

      expect(message.id).toBeDefined()
      expect(message.content).toBe("New message")
      expect(message.role).toBe("user")
      expect(mockMessages[sessionId].length).toBe(3)
    })

    it("should add message with custom role", async () => {
      const api = createSessionAPI(testPluginId)
      const message = await api.addMessage(sessionId, "Assistant response", {
        role: "assistant",
      })

      expect(message.role).toBe("assistant")
    })

    it("should update a message", async () => {
      const api = createSessionAPI(testPluginId)
      await api.updateMessage(sessionId, "msg-1", { content: "Updated content" })

      expect(mockMessages[sessionId][0].content).toBe("Updated content")
    })

    it("should delete a message", async () => {
      const api = createSessionAPI(testPluginId)
      await api.deleteMessage(sessionId, "msg-1")

      expect(mockMessages[sessionId].length).toBe(1)
      expect(mockMessages[sessionId].find((m) => m.id === "msg-1")).toBeUndefined()
    })

    it("should return empty array for non-existent session", async () => {
      const api = createSessionAPI(testPluginId)
      const messages = await api.getMessages("non-existent")

      expect(messages).toEqual([])
    })
  })

  describe("onSessionChange", () => {
    it("should subscribe to session changes", () => {
      const api = createSessionAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onSessionChange(handler)

      expect(typeof unsubscribe).toBe("function")
      expect(mockSubscribers.length).toBe(1)
    })

    it("should unsubscribe when cleanup is called", () => {
      const api = createSessionAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onSessionChange(handler)
      expect(mockSubscribers.length).toBe(1)

      unsubscribe()
      expect(mockSubscribers.length).toBe(0)
    })
  })

  describe("onMessagesChange", () => {
    it("should subscribe to message changes", () => {
      const api = createSessionAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onMessagesChange("session-1", handler)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should stop listening when unsubscribed", () => {
      const api = createSessionAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onMessagesChange("session-1", handler)
      expect(messageHooks.creating.size).toBe(1)
      expect(messageHooks.updating.size).toBe(1)
      expect(messageHooks.deleting.size).toBe(1)

      unsubscribe()

      expect(messageHooks.creating.size).toBe(0)
      expect(messageHooks.updating.size).toBe(0)
      expect(messageHooks.deleting.size).toBe(0)
    })
  })

  describe("getSessionStats", () => {
    it("should return session statistics", async () => {
      mockSessions.push({
        id: "stats-session",
        title: "Stats Session",
        mode: "chat",
        createdAt: new Date(),
        updatedAt: new Date(),
        branches: [{ id: "branch-1" }],
      } as Session)
      mockMessages["stats-session"] = [
        { id: "m1", role: "user", content: "Hello", createdAt: new Date() },
        {
          id: "m2",
          role: "assistant",
          content: "Hi",
          createdAt: new Date(),
          tokens: { total: 100, prompt: 50, completion: 50 },
        },
        {
          id: "m3",
          role: "user",
          content: "How are you?",
          createdAt: new Date(),
          attachments: [
            {
              id: "a1",
              name: "file.txt",
              type: "file",
              mimeType: "text/plain",
              url: "",
              size: 100,
            },
          ],
        },
        {
          id: "m4",
          role: "assistant",
          content: "Good!",
          createdAt: new Date(),
          tokens: { total: 50, prompt: 25, completion: 25 },
        },
      ]

      const api = createSessionAPI(testPluginId)
      const stats = await api.getSessionStats("stats-session")

      expect(stats.messageCount).toBe(4)
      expect(stats.userMessageCount).toBe(2)
      expect(stats.assistantMessageCount).toBe(2)
      expect(stats.totalTokens).toBe(150)
      expect(stats.attachmentCount).toBe(1)
      expect(stats.branchCount).toBe(1)
    })

    it("should return default stats for non-existent session", async () => {
      const api = createSessionAPI(testPluginId)
      const stats = await api.getSessionStats("non-existent")

      expect(stats.messageCount).toBe(0)
      expect(stats.userMessageCount).toBe(0)
      expect(stats.assistantMessageCount).toBe(0)
      expect(stats.totalTokens).toBe(0)
    })
  })
})
