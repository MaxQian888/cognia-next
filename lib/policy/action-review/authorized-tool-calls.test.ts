import {
  AUTHORIZED_TOOL_CALL_TTL_MS,
  MAX_TRACKED_TOOL_CALLS,
  __resetAuthorizedToolCallsForTesting,
  authorizeOutboundToolCall,
  authorizedOutboundToolCall,
  beginOutboundToolExecution,
  endOutboundToolExecution,
  forgetPlannedOutboundToolCall,
  rememberPlannedOutboundToolCall,
  runningAuthorizedToolCallsOf,
  type PlannedOutboundToolCall,
} from "./authorized-tool-calls"

const call: PlannedOutboundToolCall = {
  sessionId: "s1",
  requestId: "req_1",
  toolUseId: "toolu_1",
  toolName: "im_broadcast",
  fingerprints: ["fp-a", "fp-b"],
}

beforeEach(() => __resetAuthorizedToolCallsForTesting())

describe("authorized outbound tool calls", () => {
  it("authorizes a planned call by its tool use once it is allowed", () => {
    rememberPlannedOutboundToolCall(call, 1_000)
    expect(authorizedOutboundToolCall("s1", "toolu_1", 1_000)).toBeUndefined()
    expect(
      authorizeOutboundToolCall(
        "s1",
        "req_1",
        { authority: "human", grant: { scope: "once" } },
        2_000
      )
    ).toBe(true)
    expect(authorizedOutboundToolCall("s1", "toolu_1", 2_000)).toEqual({
      ...call,
      authority: "human",
      grant: { scope: "once" },
      authorizedAt: 2_000,
    })
  })

  it("authorizes nothing for a call that was never planned or was refused", () => {
    expect(authorizeOutboundToolCall("s1", "req_1", { authority: "human" })).toBe(false)
    rememberPlannedOutboundToolCall(call)
    forgetPlannedOutboundToolCall("s1", "req_1")
    expect(authorizeOutboundToolCall("s1", "req_1", { authority: "human" })).toBe(false)
    expect(authorizedOutboundToolCall("s1", "toolu_1")).toBeUndefined()
  })

  it("answers a call once: a second allow finds nothing left to promote", () => {
    rememberPlannedOutboundToolCall(call)
    expect(authorizeOutboundToolCall("s1", "req_1", { authority: "policy-default" })).toBe(true)
    expect(authorizeOutboundToolCall("s1", "req_1", { authority: "human" })).toBe(false)
    expect(authorizedOutboundToolCall("s1", "toolu_1")?.authority).toBe("policy-default")
  })

  it("keeps a call's plan and its authorization only for the TTL", () => {
    rememberPlannedOutboundToolCall(call, 0)
    expect(
      authorizeOutboundToolCall(
        "s1",
        "req_1",
        { authority: "human" },
        AUTHORIZED_TOOL_CALL_TTL_MS + 1
      )
    ).toBe(false)

    rememberPlannedOutboundToolCall(call, 0)
    authorizeOutboundToolCall("s1", "req_1", { authority: "human" }, 0)
    expect(authorizedOutboundToolCall("s1", "toolu_1", AUTHORIZED_TOOL_CALL_TTL_MS)).toBeDefined()
    expect(
      authorizedOutboundToolCall("s1", "toolu_1", AUTHORIZED_TOOL_CALL_TTL_MS + 1)
    ).toBeUndefined()
  })

  it("does not let one session's call authorize another session's", () => {
    rememberPlannedOutboundToolCall(call)
    authorizeOutboundToolCall("s1", "req_1", { authority: "human" })
    expect(authorizedOutboundToolCall("s2", "toolu_1")).toBeUndefined()
  })

  it("finds a plugin's authorized calls only while they run", () => {
    rememberPlannedOutboundToolCall(call)
    authorizeOutboundToolCall("s1", "req_1", { authority: "human" })
    expect(runningAuthorizedToolCallsOf("plugin:p1")).toEqual([])
    beginOutboundToolExecution("s1", "toolu_1", "plugin:p1")
    expect(runningAuthorizedToolCallsOf("plugin:p1").map((c) => c.toolUseId)).toEqual(["toolu_1"])
    expect(runningAuthorizedToolCallsOf("plugin:p2")).toEqual([])
    endOutboundToolExecution("s1", "toolu_1")
    expect(runningAuthorizedToolCallsOf("plugin:p1")).toEqual([])
    // The authorization ends with the call.
    expect(authorizedOutboundToolCall("s1", "toolu_1")).toBeUndefined()
  })

  it("drops the oldest calls past the bound", () => {
    for (let i = 0; i <= MAX_TRACKED_TOOL_CALLS; i++) {
      rememberPlannedOutboundToolCall({ ...call, requestId: `r${i}`, toolUseId: `t${i}` })
    }
    expect(authorizeOutboundToolCall("s1", "r0", { authority: "human" })).toBe(false)
    expect(authorizeOutboundToolCall("s1", "r1", { authority: "human" })).toBe(true)
  })
})
