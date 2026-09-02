import { describeExternalAgentFailure, failureLines, flattenErrorCauses } from "./agent-failure"

describe("flattenErrorCauses", () => {
  it("keeps the sentence the outer message was hiding", () => {
    // The real shape from a failed Pi connect: the adapter wraps the version
    // probe's verdict, and `error.message` alone loses the only line that says
    // what to do about it.
    const root = new Error("Could not determine the Pi version (requires 0.84.1 or newer)")
    const wrapper = new Error("Failed to connect agent pi-1", { cause: root })
    expect(flattenErrorCauses(wrapper)).toEqual([
      "Could not determine the Pi version (requires 0.84.1 or newer)",
    ])
  })

  it("walks a chain deeper than one level", () => {
    const a = new Error("socket closed")
    const b = new Error("rpc call failed", { cause: a })
    const c = new Error("connect failed", { cause: b })
    expect(flattenErrorCauses(c)).toEqual(["rpc call failed", "socket closed"])
  })

  it("does not repeat a cause that re-threw the same sentence", () => {
    const root = new Error("same")
    const wrapper = new Error("same", { cause: root })
    expect(flattenErrorCauses(wrapper)).toEqual([])
  })

  it("stops at the depth limit rather than following a cycle", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    // A library that points a cause back at its wrapper would otherwise spin.
    ;(a as Error & { cause?: unknown }).cause = b
    expect(flattenErrorCauses(b).length).toBeLessThanOrEqual(4)
  })

  it("reads a cause that is a plain value rather than an Error", () => {
    expect(flattenErrorCauses(new Error("outer", { cause: "a string reason" }))).toEqual([
      "a string reason",
    ])
    expect(
      flattenErrorCauses(new Error("outer", { cause: { message: "shaped like one" } }))
    ).toEqual(["shaped like one"])
  })

  it("returns nothing for an error with no cause", () => {
    expect(flattenErrorCauses(new Error("alone"))).toEqual([])
    expect(flattenErrorCauses("just a string")).toEqual([])
  })
})

describe("describeExternalAgentFailure", () => {
  it("records which agent failed and what was being attempted", () => {
    const failure = describeExternalAgentFailure("pi-1", "connect", new Error("boom"), 1000)
    expect(failure).toEqual({
      agentId: "pi-1",
      phase: "connect",
      message: "boom",
      causes: [],
      at: 1000,
    })
  })

  it("always says something, even for an error with an empty message", () => {
    // An empty red box reads as a rendering bug rather than as a failure.
    const failure = describeExternalAgentFailure("pi-1", "connect", new Error(""), 1)
    expect(failure.message.length).toBeGreaterThan(0)
  })
})

describe("failureLines", () => {
  it("puts the outermost message first and drops empties", () => {
    const failure = describeExternalAgentFailure(
      "pi-1",
      "connect",
      new Error("outer", { cause: new Error("inner") }),
      1
    )
    expect(failureLines(failure)).toEqual(["outer", "inner"])
  })
})
