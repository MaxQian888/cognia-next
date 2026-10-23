import contract from "@cognia/companion-client/browser-agent-protocol.json"

import {
  AGENT_OPERATIONS,
  AGENT_PROFILE,
  HELLO_VERSION,
  AgentOperationError,
  isAgentOperation,
  parseHostFrame,
  serializeFrame,
  toFailure,
  operationBudgetMs,
} from "./protocol"

describe("device socket protocol", () => {
  it("normalizes finite positive operation budgets and enforces the Host ceiling", () => {
    expect(operationBudgetMs(0.5)).toBe(1)
    expect(operationBudgetMs(1_000)).toBe(1_000)
    expect(operationBudgetMs(1_000_000)).toBe(120_000)
    for (const value of [Infinity, NaN, -1, 0, "1000", undefined])
      expect(operationBudgetMs(value)).toBe(30_000)
  })
  it("matches the published contract without reading the Host checkout", () => {
    expect(contract.operations).toEqual([...AGENT_OPERATIONS])
    expect(HELLO_VERSION).toBe(1)
    expect(AGENT_PROFILE).toBe("agent-safe-v1")
  })

  it("parses the frames the Host sends", () => {
    expect(parseHostFrame('{"t":"welcome","v":1,"connectionId":"c","driveAllowed":true}')).toEqual({
      t: "welcome",
      v: 1,
      connectionId: "c",
      driveAllowed: true,
      agentProfile: null,
    })
    expect(
      parseHostFrame('{"t":"op","id":"1","op":"snapshot","args":{"session":"s"},"deadlineMs":5000}')
    ).toEqual({ t: "op", id: "1", op: "snapshot", args: { session: "s" }, deadlineMs: 5000 })
    expect(parseHostFrame('{"t":"status","at":9}')).toEqual({ t: "status", at: 9 })
    expect(parseHostFrame('{"t":"drive","allowed":false}')).toEqual({ t: "drive", allowed: false })
    expect(parseHostFrame('{"t":"heartbeat"}')).toEqual({ t: "heartbeat" })
  })

  it("keeps an unknown operation answerable, and ignores unknown frames", () => {
    const frame = parseHostFrame('{"t":"op","id":"7","op":"run_shell","args":{}}')
    expect(frame).toMatchObject({ t: "op", id: "7" })
    expect(frame && "op" in frame && isAgentOperation(frame.op)).toBe(false)
    expect(parseHostFrame('{"t":"future"}')).toBeNull()
    expect(parseHostFrame("not json")).toBeNull()
    expect(parseHostFrame('{"t":"op","op":"snapshot"}')).toBeNull()
  })

  it("serializes answers and keeps refusal codes", () => {
    expect(JSON.parse(serializeFrame({ t: "result", id: "1", ok: true, value: 3 }))).toEqual({
      t: "result",
      id: "1",
      ok: true,
      value: 3,
    })
    expect(toFailure(new AgentOperationError("browser_user_takeover", "taken over"))).toEqual({
      code: "browser_user_takeover",
      message: "taken over",
    })
    expect(toFailure(new Error("boom"))).toEqual({
      code: "browser_extension_error",
      message: "boom",
    })
  })
})
