/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"
import type { PendingApproval, SendOptions } from "@/lib/claude/types"
import {
  useChatStore,
  MAX_CONCURRENT_STREAMS,
  selectStreamingSessionIds,
  selectStreamingCount,
  selectIsAtStreamCap,
  useSessionMessages,
  useSessionStatus,
  useSessionErrorMessage,
  useSessionPendingApprovals,
  useSessionHasMessages,
  useSessionMessagesLoading,
  useSessionMessagesLoadError,
  useIsAtStreamCap,
  type FileReference,
  type LastSendCacheEntry,
  type PendingCommandOverrides,
} from "./chat-store"
// Touch the barrel so its `export * from "./chat-store"` line is covered.
import * as barrel from "./"
import {
  ExecutionBroker,
  DEFAULT_AI_TURN_LIMIT,
  __resetExecutionBrokerForTesting,
  getExecutionBroker,
} from "@/lib/execution/broker"
import type { ExecutionLease } from "@/lib/execution/types"

it("barrel re-exports useChatStore", () => {
  expect(barrel.useChatStore).toBe(useChatStore)
})

it("MAX_CONCURRENT_STREAMS reflects the unified broker ceiling", () => {
  expect(MAX_CONCURRENT_STREAMS).toBe(DEFAULT_AI_TURN_LIMIT)
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

    it("bumps activeSessionEpoch on every change (including clears)", () => {
      const { result } = renderHook(() => useChatStore())
      const start = result.current.activeSessionEpoch
      act(() => result.current.setActiveSession("session-9"))
      const afterSet = result.current.activeSessionEpoch
      expect(afterSet).toBeGreaterThan(start)
      act(() => result.current.setActiveSession(null))
      expect(result.current.activeSessionEpoch).toBeGreaterThan(afterSet)
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
    // Approvals route by `approval.sessionId`; focus "s1" so the projection
    // mirrors that slice for the top-level assertions below.
    beforeEach(() => {
      act(() => useChatStore.getState().setActiveSession("s1"))
    })

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
        // Force the slice status to a non-approval state to simulate a race.
        useChatStore.setState((st) => ({
          status: "error",
          sessions: { ...st.sessions, s1: { ...st.sessions.s1, status: "error" } },
        }))
      })
      act(() => result.current.clearApproval("only"))
      expect(result.current.pendingApprovals).toEqual([])
      // Should NOT be flipped because status wasn't awaiting_approval
      expect(result.current.status).toBe("error")
    })

    it("pushApproval stamps requestedAt on the stored entry", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval(approval("r1")))
      expect(typeof result.current.pendingApprovals[0].requestedAt).toBe("number")
    })

    it("re-buckets a dispatched-subagent ask into its parent chat session", async () => {
      const { registerSubagentApprovalRoute, __clearAllSubagentApprovalRoutesForTesting } =
        await import("@/lib/claude/agents/subagent-approval-routes")
      __clearAllSubagentApprovalRoutesForTesting()
      registerSubagentApprovalRoute("eph-1", {
        parentSessionId: "s1",
        runId: "run-1",
        subagentId: "explore",
        backgrounded: false,
      })
      const { result } = renderHook(() => useChatStore())
      act(() =>
        result.current.pushApproval({
          requestId: "sub-req",
          sessionId: "eph-1",
          toolUseID: "tu",
          toolName: "Bash",
          input: {},
          origin: "subagent",
          subagentId: "explore",
          subagentRunId: "run-1",
        } as unknown as PendingApproval)
      )
      // The ask surfaces in the PARENT session slice (s1), not the ephemeral id.
      expect(result.current.pendingApprovals.map((a) => a.requestId)).toContain("sub-req")
      // markApprovalInterrupted on the ephemeral id still finds the parent entry.
      act(() => result.current.markApprovalInterrupted("sub-req", "eph-1", "aborted"))
      expect(result.current.pendingApprovals.find((a) => a.requestId === "sub-req")?.status).toBe(
        "interrupted"
      )
      __clearAllSubagentApprovalRoutesForTesting()
    })

    it("markApprovalInterrupted flags the entry, keeps it, and restores streaming", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval(approval("r1")))
      expect(result.current.status).toBe("awaiting_approval")
      act(() => result.current.markApprovalInterrupted("r1", "s1", "aborted"))
      const entry = result.current.pendingApprovals[0]
      expect(entry.status).toBe("interrupted")
      expect(entry.interruptReason).toBe("aborted")
      // The entry stays for the Dismiss affordance, but the slice is no longer
      // blocked on an unanswerable dialog.
      expect(result.current.status).toBe("streaming")
    })

    it("markApprovalInterrupted keeps awaiting_approval while a live approval remains", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.pushApproval(approval("dead"))
        result.current.pushApproval(approval("live"))
      })
      act(() => result.current.markApprovalInterrupted("dead", "s1"))
      expect(result.current.status).toBe("awaiting_approval")
      expect(result.current.pendingApprovals.map((a) => a.status)).toEqual([
        "interrupted",
        undefined,
      ])
    })

    it("markApprovalInterrupted locates the slice by scan when sessionId is omitted", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval({ ...approval("bg"), sessionId: "s2" }))
      act(() => result.current.markApprovalInterrupted("bg"))
      expect(result.current.sessions.s2.pendingApprovals[0].status).toBe("interrupted")
    })

    it("markApprovalInterrupted re-buckets a team sub-session id to the parent slice", () => {
      const { result } = renderHook(() => useChatStore())
      act(() =>
        result.current.pushApproval({ ...approval("t1"), sessionId: "team-9::char::alice::t" })
      )
      act(() =>
        result.current.markApprovalInterrupted("t1", "team-9::char::alice::t", "session closed")
      )
      expect(result.current.sessions["team-9"].pendingApprovals[0].status).toBe("interrupted")
    })

    it("markApprovalInterrupted is a no-op for unknown ids and already-interrupted entries", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval(approval("r1")))
      const before = useChatStore.getState()
      act(() => result.current.markApprovalInterrupted("ghost", "s1"))
      expect(useChatStore.getState().sessions.s1).toBe(before.sessions.s1)
      act(() => result.current.markApprovalInterrupted("r1", "s1"))
      const flagged = useChatStore.getState().sessions.s1
      act(() => result.current.markApprovalInterrupted("r1", "s1"))
      expect(useChatStore.getState().sessions.s1).toBe(flagged)
    })

    it("clearApproval dismisses an interrupted entry", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval(approval("r1")))
      act(() => result.current.markApprovalInterrupted("r1", "s1"))
      act(() => result.current.clearApproval("r1"))
      expect(result.current.pendingApprovals).toEqual([])
    })

    it("clearApproval is a no-op for an unknown id", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.pushApproval(approval("real")))
      act(() => result.current.clearApproval("ghost"))
      expect(result.current.pendingApprovals.map((a) => a.requestId)).toEqual(["real"])
    })

    it("routes an approval to its own session slice, not the focused one", () => {
      const { result } = renderHook(() => useChatStore())
      // Focused on "s1"; an approval arrives for background session "s2".
      const bgApproval = { ...approval("bg"), sessionId: "s2" }
      act(() => result.current.pushApproval(bgApproval))
      // Focused projection (s1) is untouched.
      expect(result.current.pendingApprovals).toEqual([])
      // s2's slice carries the approval and is awaiting_approval.
      expect(result.current.sessions.s2.pendingApprovals.map((a) => a.requestId)).toEqual(["bg"])
      expect(result.current.sessions.s2.status).toBe("awaiting_approval")
      // Clearing it (scoped) does not disturb the focused session.
      act(() => result.current.clearApproval("bg", "s2"))
      expect(result.current.sessions.s2.pendingApprovals).toEqual([])
    })

    it("buckets a team sub-session approval under the parent team session", () => {
      const { result } = renderHook(() => useChatStore())
      // Approval arrives tagged with the sub-session id but must land in the
      // team session's slice so panes/projection can see it.
      const teamApproval = { ...approval("t1"), sessionId: "team-9::char::alice::turn1" }
      act(() => result.current.pushApproval(teamApproval))
      expect(result.current.sessions["team-9"].pendingApprovals.map((a) => a.requestId)).toEqual([
        "t1",
      ])
      expect(result.current.sessions["team-9"].status).toBe("awaiting_approval")
      // The original sub-session id is preserved on the approval for routing.
      expect(result.current.sessions["team-9"].pendingApprovals[0].sessionId).toBe(
        "team-9::char::alice::turn1"
      )
      // No slice is materialised under the raw sub-session id.
      expect(result.current.sessions["team-9::char::alice::turn1"]).toBeUndefined()
      // clearApproval finds it by scan and resolves the team slice status.
      act(() => result.current.clearApproval("t1"))
      expect(result.current.sessions["team-9"].pendingApprovals).toEqual([])
      expect(result.current.sessions["team-9"].status).toBe("streaming")
    })

    it("projects a team sub-session approval when the team session is active", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveSession("team-9"))
      act(() =>
        result.current.pushApproval({ ...approval("t2"), sessionId: "team-9::char::bob::t" })
      )
      expect(result.current.pendingApprovals.map((a) => a.requestId)).toEqual(["t2"])
      expect(result.current.status).toBe("awaiting_approval")
    })

    it("two sessions hold independent approval queues simultaneously", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.pushApproval({ ...approval("a1"), sessionId: "s1" })
        result.current.pushApproval({ ...approval("b1"), sessionId: "s2" })
      })
      expect(result.current.sessions.s1.pendingApprovals.map((a) => a.requestId)).toEqual(["a1"])
      expect(result.current.sessions.s2.pendingApprovals.map((a) => a.requestId)).toEqual(["b1"])
      // Resolving s2's approval leaves s1's queue intact.
      act(() => result.current.clearApproval("b1"))
      expect(result.current.sessions.s1.pendingApprovals.map((a) => a.requestId)).toEqual(["a1"])
      expect(result.current.sessions.s2.pendingApprovals).toEqual([])
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

  describe("referencedWorkflowElements", () => {
    beforeEach(() => {
      act(() => useChatStore.getState().clearReferencedWorkflowElements())
    })

    it("adds a node reference", () => {
      const { result } = renderHook(() => useChatStore())
      act(() =>
        result.current.addReferencedWorkflowElement({
          type: "node",
          id: "n_a",
          label: "Draft",
          kind: "ai.prompt",
        })
      )
      expect(result.current.referencedWorkflowElements).toEqual([
        { type: "node", id: "n_a", label: "Draft", kind: "ai.prompt" },
      ])
    })

    it("dedupes by type + id", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.addReferencedWorkflowElement({
          type: "node",
          id: "n_a",
          label: "A",
          kind: "k",
        })
        result.current.addReferencedWorkflowElement({
          type: "node",
          id: "n_a",
          label: "A2",
          kind: "k",
        })
      })
      expect(result.current.referencedWorkflowElements).toHaveLength(1)
      // Same id + different type is a distinct reference.
      act(() =>
        result.current.addReferencedWorkflowElement({
          type: "edge",
          id: "n_a",
          label: "E",
          kind: "default",
        })
      )
      expect(result.current.referencedWorkflowElements).toHaveLength(2)
    })

    it("removes by type + id (no-op when missing)", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.addReferencedWorkflowElement({
          type: "node",
          id: "n_a",
          label: "A",
          kind: "k",
        })
        result.current.addReferencedWorkflowElement({
          type: "edge",
          id: "e_1",
          label: "E",
          kind: "default",
        })
      })
      act(() => result.current.removeReferencedWorkflowElement("node", "n_a"))
      expect(result.current.referencedWorkflowElements.map((r) => r.id)).toEqual(["e_1"])
      act(() => result.current.removeReferencedWorkflowElement("node", "missing"))
      expect(result.current.referencedWorkflowElements).toHaveLength(1)
    })

    it("clears the list", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.addReferencedWorkflowElement({
          type: "node",
          id: "n_a",
          label: "A",
          kind: "k",
        })
      })
      act(() => result.current.clearReferencedWorkflowElements())
      expect(result.current.referencedWorkflowElements).toEqual([])
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

    it("removeEphemeralSkillIds drops the given ids (e.g. on skill delete)", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setEphemeralSkillIds(["a", "b", "c"]))
      act(() => result.current.removeEphemeralSkillIds(["b", "x"]))
      expect(result.current.ephemeralSkillIds).toEqual(["a", "c"])
    })

    it("removeEphemeralSkillIds is a no-op when nothing matches", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setEphemeralSkillIds(["a"]))
      const before = result.current.ephemeralSkillIds
      act(() => result.current.removeEphemeralSkillIds(["z"]))
      expect(result.current.ephemeralSkillIds).toBe(before)
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

    it("setActiveSession preserves cached entries (background retries must survive a focus switch)", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setLastSend("s1", makeEntry())
        result.current.setLastSend("s2", makeEntry())
      })
      act(() => result.current.setActiveSession("s3"))
      expect(Object.keys(result.current.lastSendBySession).sort()).toEqual(["s1", "s2"])
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

  describe("activeBranchByGroup", () => {
    it("starts empty", () => {
      const { result } = renderHook(() => useChatStore())
      expect(result.current.activeBranchByGroup).toEqual({})
    })

    it("setActiveBranch writes the active id for a group", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveBranch("g1", "m2"))
      expect(result.current.activeBranchByGroup).toEqual({ g1: "m2" })
    })

    it("setActiveBranch is a no-op when the active id is unchanged", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveBranch("g1", "m2"))
      const snapshotMap = result.current.activeBranchByGroup
      act(() => result.current.setActiveBranch("g1", "m2"))
      expect(result.current.activeBranchByGroup).toBe(snapshotMap)
    })

    it("setActiveBranch keeps other groups intact when switching", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setActiveBranch("g1", "m1")
        result.current.setActiveBranch("g2", "n1")
      })
      act(() => result.current.setActiveBranch("g1", "m2"))
      expect(result.current.activeBranchByGroup).toEqual({ g1: "m2", g2: "n1" })
    })

    it("hydrateActiveBranches replaces the whole map", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveBranch("g1", "m1"))
      act(() => result.current.hydrateActiveBranches({ g2: "x", g3: "y" }))
      expect(result.current.activeBranchByGroup).toEqual({ g2: "x", g3: "y" })
    })

    it("clear() resets active branches", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveBranch("g1", "m1"))
      act(() => result.current.clear())
      expect(result.current.activeBranchByGroup).toEqual({})
    })

    it("setActiveSession resets active branches", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveBranch("g1", "m1"))
      act(() => result.current.setActiveSession("session-2"))
      expect(result.current.activeBranchByGroup).toEqual({})
    })
  })

  describe("per-session slices & focus switching", () => {
    it("preserves a background session's messages + status across a focus switch", () => {
      const { result } = renderHook(() => useChatStore())
      // Focus A, stream into it.
      act(() => result.current.setActiveSession("A"))
      act(() => {
        result.current.setMessages([msg("a1")])
        result.current.setStatus("streaming")
      })
      // Switch focus to B — A's slice must be untouched.
      act(() => result.current.setActiveSession("B"))
      expect(result.current.messages).toEqual([]) // projection now reflects B
      expect(result.current.sessions.A.messages.map((m) => m.id)).toEqual(["a1"])
      expect(result.current.sessions.A.status).toBe("streaming")
    })

    it("keeps streaming a background session via session-scoped setters while another is focused", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveSession("A"))
      act(() => result.current.openSession("B"))
      // Background B receives stream events while A is focused.
      act(() => {
        result.current.setSessionStatus("B", "streaming")
        result.current.replaceSessionMessages("B", [msg("b1")])
        result.current.appendSessionMessage("B", msg("b2"))
      })
      // A (focused) projection is unaffected.
      expect(result.current.messages).toEqual([])
      expect(result.current.status).toBe("idle")
      // B's slice accumulated the stream.
      expect(result.current.sessions.B.messages.map((m) => m.id)).toEqual(["b1", "b2"])
      expect(result.current.sessions.B.status).toBe("streaming")
      // Switching to B surfaces the accumulated stream verbatim (no wipe).
      act(() => result.current.setActiveSession("B"))
      expect(result.current.messages.map((m) => m.id)).toEqual(["b1", "b2"])
      expect(result.current.status).toBe("streaming")
    })

    it("session-scoped writes to the active session also update the projection", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveSession("A"))
      act(() => result.current.setSessionMessages("A", [msg("x")]))
      expect(result.current.messages.map((m) => m.id)).toEqual(["x"])
      act(() => result.current.setSessionError("A", "boom"))
      expect(result.current.errorMessage).toBe("boom")
      expect(result.current.status).toBe("error")
    })

    it("setSessionActiveBranch / hydrateSessionActiveBranches are isolated per session", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveSession("A"))
      act(() => {
        result.current.setSessionActiveBranch("B", "g1", "m1")
        result.current.hydrateSessionActiveBranches("C", { g9: "z" })
      })
      expect(result.current.sessions.B.activeBranchByGroup).toEqual({ g1: "m1" })
      expect(result.current.sessions.C.activeBranchByGroup).toEqual({ g9: "z" })
      // Focused A is untouched.
      expect(result.current.activeBranchByGroup).toEqual({})
      // No-op when unchanged.
      const before = result.current.sessions.B
      act(() => result.current.setSessionActiveBranch("B", "g1", "m1"))
      expect(result.current.sessions.B).toBe(before)
    })

    it("requestSessionMessagesReload bumps the per-session nonce", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.openSession("B"))
      act(() => result.current.requestSessionMessagesReload("B"))
      expect(result.current.sessions.B.messagesReloadNonce).toBe(1)
      expect(result.current.sessions.B.messagesLoading).toBe(true)
      act(() => result.current.setSessionMessagesLoadError("B", "nope"))
      expect(result.current.sessions.B.messagesLoadError).toBe("nope")
      expect(result.current.sessions.B.messagesLoading).toBe(false)
      act(() => result.current.setSessionMessagesLoading("B", true))
      expect(result.current.sessions.B.messagesLoading).toBe(true)
    })
  })

  describe("open / close / split panes", () => {
    it("setActiveSession opens a tab and openSession is idempotent", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveSession("A"))
      act(() => result.current.openSession("B"))
      act(() => result.current.openSession("B"))
      expect(result.current.openSessionIds).toEqual(["A", "B"])
    })

    it("closeSession drops the slice, tab, lastSend, and split reference", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setActiveSession("A")
        result.current.openSession("B")
        result.current.setLastSend("B", {
          content: "x",
          options: {} as SendOptions,
          attemptIndex: 0,
        })
        result.current.setSplitSessionId("B")
      })
      act(() => result.current.closeSession("B"))
      expect(result.current.openSessionIds).toEqual(["A"])
      expect(result.current.sessions.B).toBeUndefined()
      expect(result.current.lastSendBySession.B).toBeUndefined()
      expect(result.current.splitSessionId).toBeNull()
    })

    it("closing the focused session re-focuses the rightmost remaining tab", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setActiveSession("A")
        result.current.setActiveSession("B")
      })
      act(() => result.current.setSessionMessages("A", [msg("keep")]))
      act(() => result.current.closeSession("B"))
      expect(result.current.activeSessionId).toBe("A")
      expect(result.current.messages.map((m) => m.id)).toEqual(["keep"])
    })

    it("closing the last session clears the active pointer", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => result.current.setActiveSession("A"))
      act(() => result.current.closeSession("A"))
      expect(result.current.activeSessionId).toBeNull()
      expect(result.current.messages).toEqual([])
    })

    it("closeSession on a non-focused tab keeps focus put", () => {
      const { result } = renderHook(() => useChatStore())
      act(() => {
        result.current.setActiveSession("A")
        result.current.openSession("B")
      })
      act(() => result.current.closeSession("B"))
      expect(result.current.activeSessionId).toBe("A")
      expect(result.current.openSessionIds).toEqual(["A"])
    })
  })

  describe("concurrency cap selectors", () => {
    const streamN = (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`)
      act(() => {
        for (const id of ids) {
          useChatStore.getState().openSession(id)
          useChatStore.getState().setSessionStatus(id, "streaming")
        }
      })
      return ids
    }

    it("selectStreamingSessionIds / selectStreamingCount count only streaming slices", () => {
      streamN(2)
      act(() => useChatStore.getState().setSessionStatus("s1", "idle"))
      const state = useChatStore.getState()
      expect(selectStreamingSessionIds(state)).toEqual(["s0"])
      expect(selectStreamingCount(state)).toBe(1)
    })

    // The cap is now owned by the unified ExecutionBroker, so drive it through
    // broker leases rather than streaming slices. A small limit keeps the test
    // legible.
    describe("broker-backed cap", () => {
      const leases: ExecutionLease[] = []
      beforeEach(() => {
        __resetExecutionBrokerForTesting(new ExecutionBroker({ limits: { "ai-turn": 3 } }))
      })
      afterEach(() => {
        for (const l of leases.splice(0)) l.release("ok")
        __resetExecutionBrokerForTesting()
      })
      const fill = async (n: number) => {
        const b = getExecutionBroker()
        for (let i = 0; i < n; i++) {
          leases.push(await b.acquire({ kind: "chat", label: `l${i}`, sessionId: `s${i}` }))
        }
      }

      it("selectIsAtStreamCap is true once the broker pool is full", async () => {
        await fill(3)
        const state = useChatStore.getState()
        // A new (unknown) session is blocked.
        expect(selectIsAtStreamCap(state, "fresh")).toBe(true)
        // A session that already holds a leg is a continuation — never blocked.
        expect(selectIsAtStreamCap(state, "s0")).toBe(false)
      })

      it("selectIsAtStreamCap is false below the cap", async () => {
        await fill(2)
        expect(selectIsAtStreamCap(useChatStore.getState(), "fresh")).toBe(false)
      })
    })
  })

  describe("per-session selector hooks", () => {
    it("read a single session's slice and fall back to stable defaults", () => {
      act(() => {
        useChatStore.getState().setActiveSession("A")
        useChatStore.getState().setSessionMessages("B", [msg("b")])
        useChatStore.getState().setSessionStatus("B", "streaming")
        useChatStore.getState().setSessionError("E", "err")
      })
      const a = renderHook(() => useSessionMessages("A"))
      expect(a.result.current).toEqual([])
      const b = renderHook(() => useSessionMessages("B"))
      expect(b.result.current.map((m) => m.id)).toEqual(["b"])
      expect(renderHook(() => useSessionStatus("B")).result.current).toBe("streaming")
      expect(renderHook(() => useSessionErrorMessage("E")).result.current).toBe("err")
      expect(renderHook(() => useSessionHasMessages("B")).result.current).toBe(true)
      expect(renderHook(() => useSessionHasMessages("A")).result.current).toBe(false)
      // null session id → stable defaults.
      expect(renderHook(() => useSessionMessages(null)).result.current).toEqual([])
      expect(renderHook(() => useSessionStatus(null)).result.current).toBe("idle")
      expect(renderHook(() => useSessionErrorMessage(null)).result.current).toBeNull()
      expect(renderHook(() => useSessionHasMessages(null)).result.current).toBe(false)
      expect(renderHook(() => useSessionPendingApprovals(null)).result.current).toEqual([])
      expect(renderHook(() => useSessionMessagesLoading(null)).result.current).toBe(false)
      expect(renderHook(() => useSessionMessagesLoadError(null)).result.current).toBeNull()
    })

    it("useSessionPendingApprovals / loading / loadError read the slice", () => {
      act(() => {
        useChatStore.getState().openSession("B")
        useChatStore.getState().pushApproval({ ...approval("p1"), sessionId: "B" })
        useChatStore.getState().setSessionMessagesLoading("B", true)
      })
      expect(
        renderHook(() => useSessionPendingApprovals("B")).result.current.map((a) => a.requestId)
      ).toEqual(["p1"])
      expect(renderHook(() => useSessionMessagesLoading("B")).result.current).toBe(true)
      act(() => useChatStore.getState().setSessionMessagesLoadError("B", "x"))
      expect(renderHook(() => useSessionMessagesLoadError("B")).result.current).toBe("x")
    })

    it("useIsAtStreamCap reacts to the broker cap", async () => {
      __resetExecutionBrokerForTesting(new ExecutionBroker({ limits: { "ai-turn": 3 } }))
      const broker = getExecutionBroker()
      const fresh = renderHook(() => useIsAtStreamCap("fresh"))
      const c0 = renderHook(() => useIsAtStreamCap("c0"))
      const nullHook = renderHook(() => useIsAtStreamCap(null))
      expect(fresh.result.current).toBe(false)

      const leases: ExecutionLease[] = []
      await act(async () => {
        for (let i = 0; i < 3; i++) {
          leases.push(await broker.acquire({ kind: "chat", label: `c${i}`, sessionId: `c${i}` }))
        }
      })
      fresh.rerender()
      c0.rerender()
      expect(fresh.result.current).toBe(true)
      // c0 already holds a leg → continuation, never blocked.
      expect(c0.result.current).toBe(false)
      expect(nullHook.result.current).toBe(false)

      act(() => {
        for (const l of leases) l.release("ok")
      })
      __resetExecutionBrokerForTesting()
    })
  })
})

describe("selectVisibleMessages", () => {
  // Importing via require here to avoid a TDZ on the helper export.
  const { selectVisibleMessages } = require("./chat-store") as typeof import("./chat-store")

  const withBranch = (id: string, groupId?: string, branchIndex?: number, text = ""): UIMessage =>
    ({
      id,
      role: "assistant",
      parts: [{ type: "text", text }],
      metadata: groupId ? { branchGroupId: groupId, branchIndex: branchIndex ?? 0 } : undefined,
    }) as unknown as UIMessage

  it("passes through messages without a branchGroupId", () => {
    const a = withBranch("a")
    const b = withBranch("b")
    expect(selectVisibleMessages([a, b], {})).toEqual([a, b])
  })

  it("filters siblings down to the active id within a group", () => {
    const a = withBranch("a", "g1", 0)
    const b = withBranch("b", "g1", 1)
    const c = withBranch("c") // ungrouped follow-up
    const result = selectVisibleMessages([a, b, c], { g1: "b" })
    expect(result.map((m) => m.id)).toEqual(["b", "c"])
  })

  it("falls back to the highest branchIndex when no active id is recorded", () => {
    const a = withBranch("a", "g1", 0)
    const b = withBranch("b", "g1", 2)
    const c = withBranch("c", "g1", 1)
    const result = selectVisibleMessages([a, b, c], {})
    expect(result.map((m) => m.id)).toEqual(["b"])
  })

  it("preserves placement order across mixed branch and standalone messages", () => {
    const u = { id: "u", role: "user", parts: [] } as unknown as UIMessage
    const a = withBranch("a", "g1", 0)
    const b = withBranch("b", "g1", 1)
    const tail = withBranch("tail")
    const result = selectVisibleMessages([u, a, b, tail], { g1: "a" })
    expect(result.map((m) => m.id)).toEqual(["u", "a", "tail"])
  })
})

describe("selectBranchSiblings", () => {
  const { selectBranchSiblings } = require("./chat-store") as typeof import("./chat-store")

  const m = (id: string, branchGroupId: string, branchIndex: number): UIMessage =>
    ({
      id,
      role: "assistant",
      parts: [],
      metadata: { branchGroupId, branchIndex },
    }) as unknown as UIMessage

  it("returns siblings sorted by branchIndex", () => {
    const ms = [m("a", "g1", 2), m("b", "g1", 0), m("c", "g2", 0), m("d", "g1", 1)]
    expect(selectBranchSiblings(ms, "g1").map((x) => x.id)).toEqual(["b", "d", "a"])
  })

  it("returns [] for unknown group", () => {
    expect(selectBranchSiblings([m("a", "g1", 0)], "g2")).toEqual([])
  })
})

describe("steer queue + run timing", () => {
  const { useSessionSteerQueue, useSessionRunTiming } =
    require("./chat-store") as typeof import("./chat-store")

  beforeEach(() => {
    act(() => useChatStore.getState().clear())
  })

  it("enqueues then clears steer messages per session", () => {
    act(() => {
      useChatStore.getState().setActiveSession("s1")
      useChatStore.getState().enqueueSteer("s1", { id: "a", text: "first" })
      useChatStore.getState().enqueueSteer("s1", { id: "b", text: "second" })
    })
    const { result } = renderHook(() => useSessionSteerQueue("s1"))
    expect(result.current.map((e) => e.text)).toEqual(["first", "second"])
    act(() => useChatStore.getState().clearSteerQueue("s1"))
    expect(result.current).toEqual([])
  })

  it("preserves non-text blocks on a queued steer entry", () => {
    const blocks = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
      },
    ]
    act(() => useChatStore.getState().enqueueSteer("s1", { id: "img", text: "look", blocks }))
    const { result } = renderHook(() => useSessionSteerQueue("s1"))
    expect(result.current[0]?.blocks).toEqual(blocks)
  })

  it("removeSteerEntry drops one entry by id and is a no-op for unknown ids", () => {
    act(() => {
      useChatStore.getState().enqueueSteer("s1", { id: "a", text: "first" })
      useChatStore.getState().enqueueSteer("s1", { id: "b", text: "second" })
    })
    const { result } = renderHook(() => useSessionSteerQueue("s1"))
    act(() => useChatStore.getState().removeSteerEntry("s1", "a"))
    expect(result.current.map((e) => e.id)).toEqual(["b"])
    const before = result.current
    act(() => useChatStore.getState().removeSteerEntry("s1", "ghost"))
    expect(result.current).toBe(before) // identity preserved → no re-render
  })

  it("updateSteerEntry replaces the text but keeps the entry's blocks", () => {
    const blocks = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
      },
    ]
    act(() => useChatStore.getState().enqueueSteer("s1", { id: "a", text: "old", blocks }))
    const { result } = renderHook(() => useSessionSteerQueue("s1"))
    act(() => useChatStore.getState().updateSteerEntry("s1", "a", "new"))
    expect(result.current[0]).toMatchObject({ id: "a", text: "new", blocks })
    const before = result.current
    act(() => useChatStore.getState().updateSteerEntry("s1", "ghost", "x"))
    expect(result.current).toBe(before) // unknown id → no-op
  })

  it("clearSteerQueue on an empty queue is a no-op", () => {
    act(() => useChatStore.getState().clearSteerQueue("ghost"))
    const { result } = renderHook(() => useSessionSteerQueue("ghost"))
    expect(result.current).toEqual([])
  })

  it("starts the clock on streaming and clears it on idle", () => {
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    const { result } = renderHook(() => useSessionRunTiming("s1"))
    expect(typeof result.current.startedAt).toBe("number")
    expect(result.current.pausedAt).toBeNull()
    act(() => useChatStore.getState().setSessionStatus("s1", "idle"))
    expect(result.current.startedAt).toBeNull()
  })

  it("pauses the clock on approval and resumes when it clears", () => {
    const approval = {
      sessionId: "s1",
      requestId: "r1",
      toolUseID: "t",
      toolName: "Bash",
      input: {},
    } as unknown as PendingApproval
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    act(() => useChatStore.getState().pushApproval(approval))
    const { result } = renderHook(() => useSessionRunTiming("s1"))
    expect(typeof result.current.pausedAt).toBe("number")
    act(() => useChatStore.getState().clearApproval("r1", "s1"))
    expect(result.current.pausedAt).toBeNull()
  })

  it("setError clears the run clock on the active session", () => {
    act(() => {
      useChatStore.getState().setActiveSession("s1")
      useChatStore.getState().setSessionStatus("s1", "streaming")
      useChatStore.getState().setError("boom")
    })
    expect(useChatStore.getState().sessions["s1"]?.runTiming.startedAt ?? null).toBeNull()
  })

  it("advances timing via the active projection before a slice is materialised", () => {
    act(() =>
      useChatStore.setState({
        activeSessionId: "act",
        sessions: {},
        status: "streaming",
        messages: [],
      })
    )
    act(() => useChatStore.getState().setStatus("idle"))
    expect(useChatStore.getState().sessions["act"]?.runTiming.startedAt ?? null).toBeNull()
  })

  it("returns stable defaults for a null session id", () => {
    const q = renderHook(() => useSessionSteerQueue(null))
    const timing = renderHook(() => useSessionRunTiming(null))
    expect(q.result.current).toEqual([])
    expect(timing.result.current.startedAt).toBeNull()
  })
})

describe("runId + tool timestamps", () => {
  const { useSessionRunId, makeSessionSlice } =
    require("./chat-store") as typeof import("./chat-store")

  const toolMsg = (id: string, toolCallId: string, state: string): UIMessage =>
    ({
      id,
      role: "assistant",
      parts: [{ type: "tool-Bash", state, input: { command: "ls" }, toolCallId }],
    }) as unknown as UIMessage

  beforeEach(() => {
    act(() => useChatStore.getState().clear())
  })

  it("mints a new runId on each fresh streaming turn and keeps it on settle", () => {
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    expect(useChatStore.getState().sessions["s1"]?.runId).toBe(1)
    act(() => useChatStore.getState().setSessionStatus("s1", "idle"))
    expect(useChatStore.getState().sessions["s1"]?.runId).toBe(1)
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    expect(useChatStore.getState().sessions["s1"]?.runId).toBe(2)
  })

  it("does not mint a new runId when resuming from an approval pause", () => {
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    act(() => useChatStore.getState().pushApproval(approval("r1")))
    act(() => useChatStore.getState().clearApproval("r1", "s1"))
    expect(useChatStore.getState().sessions["s1"]?.runId).toBe(1)
  })

  it("clears toolTimestamps when a fresh turn starts", () => {
    act(() =>
      useChatStore.setState({
        activeSessionId: null,
        sessions: {
          s1: {
            ...makeSessionSlice(),
            status: "idle",
            runId: 1,
            toolTimestamps: { t1: { startedAt: 1 } },
          },
        },
      })
    )
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    expect(useChatStore.getState().sessions["s1"]?.toolTimestamps).toEqual({})
    expect(useChatStore.getState().sessions["s1"]?.runId).toBe(2)
  })

  it("syncToolTimestamps stamps running then terminal tools", () => {
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    act(() =>
      useChatStore.getState().syncToolTimestamps("s1", [toolMsg("a1", "t1", "input-available")])
    )
    expect(typeof useChatStore.getState().sessions["s1"]?.toolTimestamps.t1?.startedAt).toBe(
      "number"
    )
    expect(useChatStore.getState().sessions["s1"]?.toolTimestamps.t1?.endedAt).toBeUndefined()
    act(() =>
      useChatStore.getState().syncToolTimestamps("s1", [toolMsg("a1", "t1", "output-available")])
    )
    expect(typeof useChatStore.getState().sessions["s1"]?.toolTimestamps.t1?.endedAt).toBe("number")
  })

  it("useSessionRunId returns the runId (0 for unknown / null)", () => {
    const nul = renderHook(() => useSessionRunId(null))
    expect(nul.result.current).toBe(0)
    act(() => useChatStore.getState().setSessionStatus("s1", "streaming"))
    const live = renderHook(() => useSessionRunId("s1"))
    expect(live.result.current).toBe(1)
  })
})

describe("pendingArtifactEditTarget", () => {
  beforeEach(() => {
    act(() => useChatStore.getState().clear())
  })

  it("sets and clears a per-session edit target", () => {
    act(() =>
      useChatStore.getState().setPendingArtifactEditTarget("s1", {
        artifactId: "art1",
        requestId: "req1",
      })
    )
    expect(useChatStore.getState().pendingArtifactEditTarget.s1).toEqual({
      artifactId: "art1",
      requestId: "req1",
    })

    act(() => useChatStore.getState().setPendingArtifactEditTarget("s1", null))
    expect(useChatStore.getState().pendingArtifactEditTarget.s1).toBeUndefined()
  })

  it("clearing an absent target is a no-op (stable reference)", () => {
    const before = useChatStore.getState().pendingArtifactEditTarget
    act(() => useChatStore.getState().setPendingArtifactEditTarget("nope", null))
    expect(useChatStore.getState().pendingArtifactEditTarget).toBe(before)
  })

  it("clear() resets all edit targets", () => {
    act(() =>
      useChatStore.getState().setPendingArtifactEditTarget("s1", {
        artifactId: "a",
        requestId: "r",
      })
    )
    act(() => useChatStore.getState().clear())
    expect(useChatStore.getState().pendingArtifactEditTarget).toEqual({})
  })
})

describe("artifactSelections", () => {
  beforeEach(() => {
    act(() => useChatStore.getState().clear())
  })

  const sel = (over = {}) => ({
    artifactId: "a1",
    title: "Snippet",
    snapshot: "const x = 1",
    comment: "rename",
    range: { startLine: 1, endLine: 1 },
    ...over,
  })

  it("adds, removes by index, and clears selections", () => {
    act(() => {
      useChatStore.getState().addArtifactSelection(sel({ title: "one" }))
      useChatStore.getState().addArtifactSelection(sel({ title: "two" }))
    })
    expect(useChatStore.getState().artifactSelections).toHaveLength(2)

    act(() => useChatStore.getState().removeArtifactSelection(0))
    expect(useChatStore.getState().artifactSelections).toHaveLength(1)
    expect(useChatStore.getState().artifactSelections[0].title).toBe("two")

    act(() => useChatStore.getState().clearArtifactSelections())
    expect(useChatStore.getState().artifactSelections).toHaveLength(0)
  })

  it("removeArtifactSelection ignores out-of-range indices (stable reference)", () => {
    act(() => useChatStore.getState().addArtifactSelection(sel()))
    const before = useChatStore.getState().artifactSelections
    act(() => useChatStore.getState().removeArtifactSelection(5))
    expect(useChatStore.getState().artifactSelections).toBe(before)
  })

  it("clearArtifactSelections is a no-op when already empty (stable reference)", () => {
    const before = useChatStore.getState().artifactSelections
    act(() => useChatStore.getState().clearArtifactSelections())
    expect(useChatStore.getState().artifactSelections).toBe(before)
  })

  it("focus change and clear() reset selections", () => {
    act(() => {
      useChatStore.getState().setActiveSession("s1")
      useChatStore.getState().addArtifactSelection(sel())
    })
    act(() => useChatStore.getState().setActiveSession("s2"))
    expect(useChatStore.getState().artifactSelections).toHaveLength(0)
  })
})
