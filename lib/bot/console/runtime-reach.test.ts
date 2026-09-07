import {
  botRuntimeReachIsCovered,
  resolveBotRuntimeReach,
  type BotRuntimeReachDeps,
} from "./runtime-reach"

function deps(over: Partial<BotRuntimeReachDeps> = {}): BotRuntimeReachDeps {
  return {
    hasAlwaysOn: () => false,
    remoteActive: () => false,
    hasHost: () => false,
    ...over,
  }
}

describe("resolveBotRuntimeReach", () => {
  it("calls a desktop with no remote host local", () => {
    expect(resolveBotRuntimeReach(deps({ hasAlwaysOn: () => true, hasHost: () => true }))).toBe(
      "local"
    )
  })

  it("asks about the remote host BEFORE the capability", () => {
    // `always-on` is a static baseline, so a desktop driving a remote Cognia
    // still reports it. Testing the capability first would call that shell
    // local and tell the user its own runner is draining a mirrored queue.
    expect(
      resolveBotRuntimeReach(
        deps({ hasAlwaysOn: () => true, remoteActive: () => true, hasHost: () => true })
      )
    ).toBe("remote")
  })

  it("calls a companion with a paired host paired, not local", () => {
    expect(resolveBotRuntimeReach(deps({ hasHost: () => true }))).toBe("paired")
  })

  it("calls a standalone browser tab uncovered", () => {
    // The case the notice exists for: armed triggers and a healthy status for
    // a Bot that will never fire once.
    expect(resolveBotRuntimeReach(deps())).toBe("none")
  })
})

describe("botRuntimeReachIsCovered", () => {
  it("is true for every reach except none", () => {
    expect(botRuntimeReachIsCovered("local")).toBe(true)
    expect(botRuntimeReachIsCovered("remote")).toBe(true)
    expect(botRuntimeReachIsCovered("paired")).toBe(true)
    expect(botRuntimeReachIsCovered("none")).toBe(false)
  })
})
