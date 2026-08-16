import {
  isCodeModeKilled,
  resolveCodeModeAvailability,
  supportedOrchestrations,
  supportedToolPresentations,
} from "./availability"

const SANDBOXED = { canSpawnProcess: true, strictSandbox: true }

describe("resolveCodeModeAvailability", () => {
  it("is available on a host with a strict sandbox", () => {
    expect(resolveCodeModeAvailability({ probe: SANDBOXED, environment: {} })).toEqual({
      available: true,
    })
  })

  // The rule the whole module exists for: no sandbox, no Code, no fallback.
  it("fails closed when the sandbox is not strict", () => {
    expect(
      resolveCodeModeAvailability({
        probe: { canSpawnProcess: true, strictSandbox: false },
        environment: {},
      })
    ).toEqual({ available: false, reason: "no-strict-sandbox" })
  })

  it("fails closed when the host cannot spawn a process", () => {
    expect(
      resolveCodeModeAvailability({
        probe: { canSpawnProcess: false, strictSandbox: true },
        environment: {},
      })
    ).toEqual({ available: false, reason: "no-host-process" })
  })

  // Browser and Capacitor hosts never probe at all.
  it("treats an unprobed host as unavailable rather than as probably fine", () => {
    expect(resolveCodeModeAvailability({ environment: {} })).toEqual({
      available: false,
      reason: "no-host-process",
    })
  })

  it("reports the kill switch ahead of the sandbox state", () => {
    expect(
      resolveCodeModeAvailability({
        probe: SANDBOXED,
        environment: { NEXT_PUBLIC_CODE_MODE_KILL: "1" },
      })
    ).toEqual({ available: false, reason: "killed" })
  })

  it('only treats an exact "1" as killed', () => {
    expect(isCodeModeKilled({ NEXT_PUBLIC_CODE_MODE_KILL: "true" })).toBe(false)
    expect(isCodeModeKilled({ NEXT_PUBLIC_CODE_MODE_KILL: "1" })).toBe(true)
    expect(isCodeModeKilled({})).toBe(false)
  })
})

describe("supportedToolPresentations", () => {
  it("offers native only when Code is unavailable", () => {
    expect(supportedToolPresentations({ environment: {} })).toEqual(["native"])
  })

  it("offers code once the sandbox is confirmed", () => {
    expect(supportedToolPresentations({ probe: SANDBOXED, environment: {} })).toEqual(
      expect.arrayContaining(["native", "code"])
    )
  })

  // `both` exposes the same run_code executor, so it has to be gated too —
  // listing only `code` would leave an unguarded route to the same sandbox.
  it("withholds `both` as well as `code` on an unsandboxed host", () => {
    expect(supportedToolPresentations({ environment: {} })).not.toContain("both")
  })

  it("offers `both` when the sandbox is available", () => {
    expect(supportedToolPresentations({ probe: SANDBOXED, environment: {} })).toContain("both")
  })

  it("withholds code when killed even on a sandboxed host", () => {
    expect(
      supportedToolPresentations({
        probe: SANDBOXED,
        environment: { NEXT_PUBLIC_CODE_MODE_KILL: "1" },
      })
    ).toEqual(["native"])
  })

  it("returns a fresh array the caller may not mutate into the constant", () => {
    const first = supportedToolPresentations({ probe: SANDBOXED, environment: {} })
    first.push("native")
    expect(supportedToolPresentations({ probe: SANDBOXED, environment: {} })).not.toEqual(first)
  })
})

describe("supportedOrchestrations", () => {
  it("is unaffected by the sandbox", () => {
    expect(supportedOrchestrations()).toEqual(
      expect.arrayContaining(["direct", "workflow", "verified-fresh-agent"])
    )
  })
})
