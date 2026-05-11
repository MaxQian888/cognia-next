import { act, renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"
import type { PendingApproval, SendOptions } from "@/lib/claude/types"
import {
  useChatStore,
  type FileReference,
  type LastSendCacheEntry,
  type PendingCommandOverrides,
} from "./chat-store"
// Touch the barrel so its `export * from "./chat-store"` line is covered.
import * as barrel from "./"

it("barrel re-exports useChatStore", () => {
  expect(barrel.useChatStore).toBe(useChatStore)
})

const msg = (id: string, text = ""): UIMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
  }) as unknown as UIMessage

const approval = (requestId: string): PendingApproval =>
  ({
    requestId,
    sessionId: "s1",
    toolName: "Write",
    input: {},
  }) as unknown as PendingApproval

const ref = (absolute: string, isDir = false): FileReference => ({
  absolute,
  relative: absolute.replace(/^\//, ""),
  isDir,
})

describe("useChatStore", () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  describe("initial state", () => {
    it("starts with documented defaults", () => {
      const { result } = renderHook(() => useChatStore())
      expect(result.current.activeSessionId).toBeNull()
      expect(result.current.messages).toEqual([])
      expect(result.current.status).toBe("idle")
      expect(result.current.errorMessage).toBeNull()
      expect(result.current.pendingApprovals).toEqual([])
      expect(result.current.permissionMode).toBeNull()
      expect(result.current.referencedPaths).toEqual([])
      expect(result.current.pendingCommandOverrides).toBeNull()
      expect(result.current.bookmarkedIds).toEqual([])
      expect(result.current.webSearchOnForNextSend).toBe(false)
    })
  })

  describe("setActiveSession", () => {
    it("sets the new session id and resets all transient session state", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setMessages([msg("a")])
        result.current.setStatus("streaming")
        result.current.setError("boom")
        result.current.pushApproval(approval("r1"))
        result.current.setPermissionMode("acceptEdits")
        result.current.addReferencedPath(ref("/x"))
        result.current.setPendingCommandOverrides({ model: "m" })
        result.current.toggleBookmark("b1")
        result.current.setWebSearchOnForNextSend(true)
      })

      act(() => result.current.setActiveSession("session-2"))

      expect(result.current.activeSessionId).toBe("session-2")
      expect(result.current.messages).toEqual([])
      expect(result.current.status).toBe("idle")
      expect(result.current.errorMessage).toBeNull()
      expect(result.current.pendingApprovals).toEqual([])
      expect(result.current.permissionMode).toBeNull()
      expect(result.current.referencedPaths).toEqual([])
      expect(result.current.pendingCommandOverrides).toBeNull()
      expect(result.current.bookmarkedIds).toEqual([])
      expect(result.current.webSearchOnForNextSend).toBe(false)
    })

    it("accepts null to clear the active session", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveSession("session-7"))
      act(() => result.current.setActiveSession(null))
      expect(result.current.activeSessionId).toBeNull()
    })
  })

  describe("messages", () => {
    it("setMessages replaces the array", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setMessages([msg("a"), msg("b")]))
      expect(result.current.messages.map((m) => m.id)).toEqual(["a", "b"])
    })

    it("appendMessage pushes to the existing array", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setMessages([msg("a")]))
      act(() => result.current.appendMessage(msg("b")))
      expect(result.current.messages.map((m) => m.id)).toEqual(["a", "b"])
    })

    it("replaceMessages overwrites the array (semantically the same as setMessages)", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setMessages([msg("a"), msg("b")]))
      act(() => result.current.replaceMessages([msg("c")]))
      expect(result.current.messages.map((m) => m.id)).toEqual(["c"])
    })
  })

  describe("status / error", () => {
    it("setStatus sets the status verbatim", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setStatus("streaming"))
      expect(result.current.status).toBe("streaming")
    })

    it("setError(msg) sets errorMessage and forces status to 'error'", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setStatus("streaming"))
      act(() => result.current.setError("network down"))
      expect(result.current.errorMessage).toBe("network down")
      expect(result.current.status).toBe("error")
    })

    it("setError(null) clears errorMessage and resets status to 'idle'", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setError("x"))
      act(() => result.current.setError(null))
      expect(result.current.errorMessage).toBeNull()
      expect(result.current.status).toBe("idle")
    })
  })

  describe("approvals", () => {
    it("pushApproval appends the approval and flips status to awaiting_approval", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setStatus("streaming"))
      act(() => result.current.pushApproval(approval("r1")))
      expect(result.current.pendingApprovals.map((a) => a.requestId)).toEqual(["r1"])
      expect(result.current.status).toBe("awaiting_approval")
    })

    it("clearApproval drops the matching id but leaves others", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.pushApproval(approval("r1"))
        result.current.pushApproval(approval("r2"))
      })
      act(() => result.current.clearApproval("r1"))
      expect(result.current.pendingApprovals.map((a) => a.requestId)).toEqual(["r2"])
      // Still has approvals → status remains awaiting_approval
      expect(result.current.status).toBe("awaiting_approval")
    })

    it("clearApproval flips status from awaiting_approval back to streaming once the queue empties", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval(approval("only")))
      act(() => result.current.clearApproval("only"))
      expect(result.current.pendingApprovals).toEqual([])
      expect(result.current.status).toBe("streaming")
    })

    it("clearApproval leaves status untouched when status was not awaiting_approval", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.pushApproval(approval("only"))
        // Override status manually to simulate a race
        useChatStore.setState({ status: "error" })
      })
      act(() => result.current.clearApproval("only"))
      expect(result.current.pendingApprovals).toEqual([])
      // Should NOT be flipped because status wasn't awaiting_approval
      expect(result.current.status).toBe("error")
    })

    it("clearApproval is a no-op for an unknown id", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval(approval("real")))
      act(() => result.current.clearApproval("ghost"))
      expect(result.current.pendingApprovals.map((a) => a.requestId)).toEqual(["real"])
    })
  })

  describe("permissionMode", () => {
    it("setPermissionMode accepts a mode and null", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setPermissionMode("acceptEdits"))
      expect(result.current.permissionMode).toBe("acceptEdits")
      act(() => result.current.setPermissionMode(null))
      expect(result.current.permissionMode).toBeNull()
    })
  })

  describe("referenced paths", () => {
    it("addReferencedPath adds a new path", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.addReferencedPath(ref("/a")))
      expect(result.current.referencedPaths.map((r) => r.absolute)).toEqual(["/a"])
    })

    it("addReferencedPath dedupes by absolute", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.addReferencedPath(ref("/a")))
      act(() => result.current.addReferencedPath(ref("/a", true)))
      expect(result.current.referencedPaths).toHaveLength(1)
    })

    it("removeReferencedPath drops by absolute and is a no-op when missing", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.addReferencedPath(ref("/a")))
      act(() => result.current.addReferencedPath(ref("/b")))
      act(() => result.current.removeReferencedPath("/a"))
      expect(result.current.referencedPaths.map((r) => r.absolute)).toEqual(["/b"])
      act(() => result.current.removeReferencedPath("/missing"))
      expect(result.current.referencedPaths.map((r) => r.absolute)).toEqual(["/b"])
    })

    it("clearReferencedPaths empties the list", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.addReferencedPath(ref("/a"))
        result.current.addReferencedPath(ref("/b"))
      })
      act(() => result.current.clearReferencedPaths())
      expect(result.current.referencedPaths).toEqual([])
    })
  })

  describe("pendingCommandOverrides", () => {
    it("setPendingCommandOverrides accepts a payload and null", () => {
      const { result } = renderHook(() => useChatStore())
      const overrides: PendingCommandOverrides = { model: "claude-haiku" }
      act(() => result.current.setPendingCommandOverrides(overrides))
      expect(result.current.pendingCommandOverrides).toEqual(overrides)
      act(() => result.current.setPendingCommandOverrides(null))
      expect(result.current.pendingCommandOverrides).toBeNull()
    })
  })

  describe("bookmarks", () => {
    it("toggleBookmark adds an id when missing", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.toggleBookmark("m1"))
      expect(result.current.bookmarkedIds).toEqual(["m1"])
    })

    it("toggleBookmark removes the id when present", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.toggleBookmark("m1"))
      act(() => result.current.toggleBookmark("m1"))
      expect(result.current.bookmarkedIds).toEqual([])
    })
  })

  describe("webSearchOnForNextSend", () => {
    it("setWebSearchOnForNextSend toggles the per-send flag", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setWebSearchOnForNextSend(true))
      expect(result.current.webSearchOnForNextSend).toBe(true)
      act(() => result.current.setWebSearchOnForNextSend(false))
      expect(result.current.webSearchOnForNextSend).toBe(false)
    })
  })

  describe("ephemeralSkillIds", () => {
    it("starts empty", () => {
      const { result } = renderHook(() => useChatStore())
      expect(result.current.ephemeralSkillIds).toEqual([])
    })

    it("setEphemeralSkillIds replaces the list", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setEphemeralSkillIds(["a", "b"]))
      expect(result.current.ephemeralSkillIds).toEqual(["a", "b"])
    })

    it("toggleEphemeralSkill adds and removes", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.toggleEphemeralSkill("a"))
      expect(result.current.ephemeralSkillIds).toEqual(["a"])
      act(() => result.current.toggleEphemeralSkill("a"))
      expect(result.current.ephemeralSkillIds).toEqual([])
    })

    it("clearEphemeralSkillIds empties the list", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setEphemeralSkillIds(["a", "b"]))
      act(() => result.current.clearEphemeralSkillIds())
      expect(result.current.ephemeralSkillIds).toEqual([])
    })
  })

  describe("clear", () => {
    it("resets every transient field back to its default", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setActiveSession("any")
        result.current.setMessages([msg("x")])
        result.current.setStatus("streaming")
        result.current.setError("e")
        result.current.pushApproval(approval("a"))
        result.current.setPermissionMode("acceptEdits")
        result.current.addReferencedPath(ref("/x"))
        result.current.setPendingCommandOverrides({ model: "m" })
        result.current.toggleBookmark("bm")
        result.current.setWebSearchOnForNextSend(true)
      })

      act(() => result.current.clear())

      expect(result.current.activeSessionId).toBeNull()
      expect(result.current.messages).toEqual([])
      expect(result.current.status).toBe("idle")
      expect(result.current.errorMessage).toBeNull()
      expect(result.current.pendingApprovals).toEqual([])
      expect(result.current.permissionMode).toBeNull()
      expect(result.current.referencedPaths).toEqual([])
      expect(result.current.pendingCommandOverrides).toBeNull()
      expect(result.current.bookmarkedIds).toEqual([])
      expect(result.current.webSearchOnForNextSend).toBe(false)
    })
  })

  describe("lastSendBySession", () => {
    const makeEntry = (provider = "openai", attemptIndex = 0): LastSendCacheEntry => ({
      content: "hi",
      options: {
        provider,
        model: "m",
        aliasResolution: {
          alias: "fast",
          resolvedTo: { providerId: provider, modelId: "m" },
          fallbackEntries: [
            { providerId: "openai", modelId: "gpt-4o-mini" },
            { providerId: "anthropic", modelId: "claude-haiku-4-5" },
          ],
        },
      } as SendOptions,
      attemptIndex,
    })

    it("starts with an empty cache", () => {
      const { result } = renderHook(() => useChatStore())
      expect(result.current.lastSendBySession).toEqual({})
    })

    it("setLastSend writes the entry under the session id", () => {
      const { result } = renderHook(() => useChatStore())
      const entry = makeEntry()
      act(() => result.current.setLastSend("s1", entry))
      expect(result.current.lastSendBySession.s1).toBe(entry)
      expect(Object.keys(result.current.lastSendBySession)).toEqual(["s1"])
    })

    it("bumpLastSendAttempt increments only the targeted session", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setLastSend("s1", makeEntry("openai", 0))
        result.current.setLastSend("s2", makeEntry("openai", 0))
      })
      act(() => result.current.bumpLastSendAttempt("s1"))
      expect(result.current.lastSendBySession.s1?.attemptIndex).toBe(1)
      expect(result.current.lastSendBySession.s2?.attemptIndex).toBe(0)
    })

    it("bumpLastSendAttempt is a no-op when session has no cache", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.bumpLastSendAttempt("missing"))
      expect(result.current.lastSendBySession).toEqual({})
    })

    it("clearLastSend removes only the targeted session", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setLastSend("s1", makeEntry())
        result.current.setLastSend("s2", makeEntry("anthropic"))
      })
      act(() => result.current.clearLastSend("s1"))
      expect(result.current.lastSendBySession.s1).toBeUndefined()
      expect(result.current.lastSendBySession.s2).toBeDefined()
    })

    it("clearLastSend is a no-op when session has no cache", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.clearLastSend("nope"))
      expect(result.current.lastSendBySession).toEqual({})
    })

    it("setActiveSession wipes all cached entries", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setLastSend("s1", makeEntry())
        result.current.setLastSend("s2", makeEntry())
      })
      act(() => result.current.setActiveSession("s3"))
      expect(result.current.lastSendBySession).toEqual({})
    })

    it("clear() wipes all cached entries", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setLastSend("s1", makeEntry())
      })
      act(() => result.current.clear())
      expect(result.current.lastSendBySession).toEqual({})
    })
  })
})
