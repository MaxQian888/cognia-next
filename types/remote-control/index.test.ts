import {
  DEFAULT_REMOTE_CONTROL_ALLOWLIST,
  DEFAULT_REMOTE_CONTROL_CONFIG,
  DEFAULT_REMOTE_CONTROL_PORT,
  DEFAULT_REMOTE_CONTROL_RATE_LIMIT_PER_MIN,
  DEFAULT_TOKEN_CAPABILITY,
  REMOTE_COMMAND_TARGETS,
  REMOTE_CONTROL_RECENT_CALLS_LIMIT,
  SENSITIVE_REMOTE_COMMAND_TARGETS,
  isLoopbackAllowlistEntry,
  isRemoteCommandTarget,
  isSensitiveRemoteCommandTarget,
  validateCidrOrIp,
} from "./index"

describe("remote-control type defaults", () => {
  it("exposes a frozen-shaped default config", () => {
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.inbound.enabled).toBe(false)
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.inbound.port).toBe(DEFAULT_REMOTE_CONTROL_PORT)
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.inbound.allowlist).toEqual(
      DEFAULT_REMOTE_CONTROL_ALLOWLIST
    )
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.inbound.rateLimitPerMin).toBe(
      DEFAULT_REMOTE_CONTROL_RATE_LIMIT_PER_MIN
    )
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.outbound).toEqual({
      hasSigningSecret: false,
      defaultHeaders: [],
      endpoints: [],
    })
  })

  it("DEFAULT config returns a fresh allowlist (so callers can mutate without leaking)", () => {
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.inbound.allowlist).not.toBe(
      DEFAULT_REMOTE_CONTROL_ALLOWLIST
    )
  })

  it("REMOTE_CONTROL_RECENT_CALLS_LIMIT is a small positive integer", () => {
    expect(Number.isInteger(REMOTE_CONTROL_RECENT_CALLS_LIMIT)).toBe(true)
    expect(REMOTE_CONTROL_RECENT_CALLS_LIMIT).toBeGreaterThan(0)
    expect(REMOTE_CONTROL_RECENT_CALLS_LIMIT).toBeLessThanOrEqual(100)
  })
})

describe("remote command targets", () => {
  it("recognises every known target", () => {
    expect(REMOTE_COMMAND_TARGETS).toContain("workflow.run")
    expect(REMOTE_COMMAND_TARGETS).toContain("workflow.cancel")
    expect(REMOTE_COMMAND_TARGETS).toContain("goal.create")
    expect(REMOTE_COMMAND_TARGETS).toContain("goal.continue")
    expect(REMOTE_COMMAND_TARGETS).toContain("goal.pause")
    expect(REMOTE_COMMAND_TARGETS).toContain("goal.resume")
    expect(REMOTE_COMMAND_TARGETS).toContain("goal.stop")
    expect(REMOTE_COMMAND_TARGETS).toContain("team.stop")
    expect(REMOTE_COMMAND_TARGETS).toContain("chat.send")
    expect(REMOTE_COMMAND_TARGETS).toContain("connector.send")
    expect(REMOTE_COMMAND_TARGETS).toHaveLength(14)
    expect(isRemoteCommandTarget("plan.run")).toBe(true)
    expect(isRemoteCommandTarget("team.dispatch")).toBe(true)
    expect(isRemoteCommandTarget("nope")).toBe(false)
  })

  it("flags only the model-cost / off-device targets as sensitive", () => {
    expect(SENSITIVE_REMOTE_COMMAND_TARGETS).toEqual(["chat.send", "connector.send", "goal.create"])
    expect(isSensitiveRemoteCommandTarget("chat.send")).toBe(true)
    expect(isSensitiveRemoteCommandTarget("connector.send")).toBe(true)
    expect(isSensitiveRemoteCommandTarget("goal.create")).toBe(true)
    // Side-effect-free targets are not sensitive.
    expect(isSensitiveRemoteCommandTarget("workflow.run")).toBe(false)
    expect(isSensitiveRemoteCommandTarget("goal.pause")).toBe(false)
  })

  it("defaults a fresh token to write capability with sensitive targets off", () => {
    expect(DEFAULT_TOKEN_CAPABILITY).toBe("write")
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.inbound.allowSensitiveTargets).toBe(false)
  })
})

describe("validateCidrOrIp", () => {
  it.each([
    ["127.0.0.1", null],
    ["127.0.0.1/32", null],
    ["10.0.0.0/8", null],
    ["192.168.1.1", null],
    ["0.0.0.0/0", null],
    ["255.255.255.255/32", null],
  ])("accepts %p", (input, expected) => {
    expect(validateCidrOrIp(input)).toBe(expected)
  })

  it.each([
    ["", "settings.remoteControl.inbound.allowlistEmpty"],
    ["   ", "settings.remoteControl.inbound.allowlistEmpty"],
    ["not-an-ip", "settings.remoteControl.inbound.allowlistInvalid"],
    ["256.0.0.1", "settings.remoteControl.inbound.allowlistInvalid"],
    ["10.0.0.1/33", "settings.remoteControl.inbound.allowlistInvalid"],
    ["10.0.0", "settings.remoteControl.inbound.allowlistInvalid"],
    ["10.0.0.1/", "settings.remoteControl.inbound.allowlistInvalid"],
    ["foo.bar.baz.qux", "settings.remoteControl.inbound.allowlistInvalid"],
  ])("rejects %p with %p", (input, expected) => {
    expect(validateCidrOrIp(input)).toBe(expected)
  })

  it("trims surrounding whitespace before validation", () => {
    expect(validateCidrOrIp("  192.168.0.1  ")).toBeNull()
  })
})

describe("isLoopbackAllowlistEntry", () => {
  it("recognizes literal loopback forms", () => {
    expect(isLoopbackAllowlistEntry("127.0.0.1")).toBe(true)
    expect(isLoopbackAllowlistEntry("127.0.0.1/32")).toBe(true)
    expect(isLoopbackAllowlistEntry("  127.0.0.1/32  ")).toBe(true)
  })

  it("rejects everything else", () => {
    expect(isLoopbackAllowlistEntry("127.0.0.2")).toBe(false)
    expect(isLoopbackAllowlistEntry("127.0.0.0/8")).toBe(false)
    expect(isLoopbackAllowlistEntry("10.0.0.1")).toBe(false)
    expect(isLoopbackAllowlistEntry("")).toBe(false)
  })
})
