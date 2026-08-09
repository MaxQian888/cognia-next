/** @jest-environment jsdom */
import {
  cancelRealtimeToolApproval,
  grantRealtimeToolAlwaysAllow,
  isRealtimeToolApprovalRequestId,
  REALTIME_TOOL_APPROVAL_PREFIX,
  requestRealtimeToolApproval,
  resolveRealtimeToolVerdict,
} from "./approval"
import {
  __resetApprovalRegistryForTesting,
  resolveApproval,
} from "@/lib/connectors/hitl/approval-registry"

/** Short alias — this file resolves a lot of verdicts. */
const resolve = resolveRealtimeToolVerdict

const pushApproval = jest.fn()
const clearApproval = jest.fn()

jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => ({ pushApproval, clearApproval }) },
}))

beforeEach(() => {
  jest.clearAllMocks()
  __resetApprovalRegistryForTesting()
})

/**
 * Let the lazy `await import("@/stores/chat/chat-store")` inside
 * `requestRealtimeToolApproval` settle before asserting on the card.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("isRealtimeToolApprovalRequestId", () => {
  it("recognises its own request ids", () => {
    // use-claude-chat branches on this to resolve locally; a miss would forward
    // the id to the sidecar, which has no waiter for it, and hang the dialog.
    expect(isRealtimeToolApprovalRequestId(`${REALTIME_TOOL_APPROVAL_PREFIX}call_1`)).toBe(true)
  })

  it("leaves other approval ids alone", () => {
    expect(isRealtimeToolApprovalRequestId("builtin-skill:notes:abc")).toBe(false)
    expect(isRealtimeToolApprovalRequestId("toolu_123")).toBe(false)
  })
})

describe("resolveRealtimeToolVerdict", () => {
  it("asks for a tool nobody has configured", () => {
    // DEFAULT_RULESET is {"*":"allow"} for the sidecar's benefit — it has a
    // coarse allow/deny layer on top and a visible tool stream. Voice has
    // neither, so the permissive default must not be inherited.
    expect(resolve("search_notes", {})).toBe("ask")
  })

  it("allows a tool the user always-allowed from the chat dialog", () => {
    expect(resolve("search_notes", { alwaysAllowTools: ["search_notes"] })).toBe("allow")
  })

  it("allows a tool with an explicit allow rule", () => {
    expect(resolve("search_notes", { toolRules: { search_notes: "allow" } })).toBe("allow")
  })

  it("allows via a glob rule", () => {
    expect(
      resolveRealtimeToolVerdict("search_notes", { toolRules: { search_notes: { "*": "allow" } } })
    ).toBe("allow")
  })

  it("denies a tool with an explicit deny rule", () => {
    expect(resolve("delete_everything", { toolRules: { delete_everything: "deny" } })).toBe("deny")
  })

  it("lets a wildcard deny cover unconfigured tools", () => {
    expect(resolve("anything", { toolRules: { "*": "deny" } })).toBe("deny")
  })

  it("treats a wildcard allow as an explicit grant", () => {
    // The user opting everything in is a deliberate choice, unlike the
    // baked-in default that happens to have the same shape.
    expect(resolve("anything", { toolRules: { "*": "allow" } })).toBe("allow")
  })

  it("lets deny win over an always-allow entry for a different tool", () => {
    expect(
      resolve("delete_everything", {
        alwaysAllowTools: ["search_notes"],
        toolRules: { delete_everything: "deny" },
      })
    ).toBe("deny")
  })
})

describe("requestRealtimeToolApproval", () => {
  const base = {
    sessionId: "s1",
    callId: "call_1",
    toolName: "search_notes",
    args: { q: "hi" },
  }

  it("runs without asking when a rule already allows it", async () => {
    const outcome = await requestRealtimeToolApproval({
      ...base,
      policy: { toolRules: { search_notes: "allow" } },
    })

    expect(outcome).toEqual({ approved: true, reason: "rule" })
    expect(pushApproval).not.toHaveBeenCalled()
  })

  it("reports an always-allow grant distinctly from a rule", async () => {
    const outcome = await requestRealtimeToolApproval({
      ...base,
      policy: { alwaysAllowTools: ["search_notes"] },
    })

    expect(outcome).toEqual({ approved: true, reason: "always-allowed" })
  })

  it("refuses a denied tool without showing a dialog", async () => {
    const outcome = await requestRealtimeToolApproval({
      ...base,
      policy: { toolRules: { search_notes: "deny" } },
    })

    expect(outcome).toEqual({ approved: false, reason: "denied-by-rule" })
    expect(pushApproval).not.toHaveBeenCalled()
  })

  it("shows a card keyed to the provider call id", async () => {
    const pending = requestRealtimeToolApproval({ ...base, policy: {} })
    await flush()

    expect(pushApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        requestId: `${REALTIME_TOOL_APPROVAL_PREFIX}call_1`,
        toolName: "search_notes",
        input: { q: "hi" },
      })
    )

    resolveApproval("s1", `${REALTIME_TOOL_APPROVAL_PREFIX}call_1`, { decision: "allow" })
    await expect(pending).resolves.toEqual({ approved: true, reason: "user" })
  })

  it("clears the card once the user answers", async () => {
    const pending = requestRealtimeToolApproval({ ...base, policy: {} })
    await flush()
    resolveApproval("s1", `${REALTIME_TOOL_APPROVAL_PREFIX}call_1`, { decision: "deny" })

    await expect(pending).resolves.toEqual({ approved: false, reason: "user" })
    // A card left behind after the promise settles is a zombie the user can
    // still click.
    expect(clearApproval).toHaveBeenCalledWith(`${REALTIME_TOOL_APPROVAL_PREFIX}call_1`, "s1")
  })

  it("auto-denies when the approval expires", async () => {
    // Real timers with a tiny TTL: the lazy store import has to resolve before
    // the registry's timer is even armed, which fake timers would deadlock.
    const outcome = await requestRealtimeToolApproval({ ...base, policy: {}, ttlMs: 20 })

    expect(outcome).toEqual({ approved: false, reason: "expired" })
  })

  it("survives the store being torn down mid-approval", async () => {
    clearApproval.mockImplementationOnce(() => {
      throw new Error("session closed")
    })

    const pending = requestRealtimeToolApproval({ ...base, policy: {} })
    await flush()
    resolveApproval("s1", `${REALTIME_TOOL_APPROVAL_PREFIX}call_1`, { decision: "allow" })

    await expect(pending).resolves.toEqual({ approved: true, reason: "user" })
  })
})

describe("cancelRealtimeToolApproval", () => {
  it("denies the pending registry waiter and clears its approval card", async () => {
    const pending = requestRealtimeToolApproval({
      sessionId: "s1",
      callId: "call_1",
      toolName: "search_notes",
      args: {},
      policy: {},
    })
    await flush()

    cancelRealtimeToolApproval("s1", "call_1")

    await expect(pending).resolves.toEqual({ approved: false, reason: "user" })
    await flush()
    expect(clearApproval).toHaveBeenCalledWith(`${REALTIME_TOOL_APPROVAL_PREFIX}call_1`, "s1")
  })

  it("survives a chat store that was already torn down", async () => {
    clearApproval.mockImplementation(() => {
      throw new Error("session removed")
    })

    expect(() => cancelRealtimeToolApproval("missing", "late-call")).not.toThrow()
    await flush()
  })
})

describe("grantRealtimeToolAlwaysAllow", () => {
  it("writes a rule the realtime resolver actually reads back", async () => {
    // Regression for the silent-failure mode: the chat path would have fallen
    // back to `alwaysAllowTools`, which only the sidecar consumes, so the voice
    // session would keep asking forever.
    const rules = grantRealtimeToolAlwaysAllow("s1", "search_notes", undefined)

    expect(resolveRealtimeToolVerdict("search_notes", { toolRules: rules })).toBe("allow")
  })

  it("stops the current session asking straight away", async () => {
    grantRealtimeToolAlwaysAllow("s2", "search_notes", undefined)

    const outcome = await requestRealtimeToolApproval({
      sessionId: "s2",
      callId: "call_9",
      toolName: "search_notes",
      args: {},
      policy: {},
    })

    // Without the session bypass this would block on the settings round-trip.
    expect(outcome).toEqual({ approved: true, reason: "session-bypass" })
  })

  it("keeps rules for other tools", () => {
    const rules = grantRealtimeToolAlwaysAllow("s3", "search_notes", {
      delete_everything: "deny",
    })

    expect(resolveRealtimeToolVerdict("delete_everything", { toolRules: rules })).toBe("deny")
  })
})
