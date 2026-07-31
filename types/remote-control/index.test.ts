import {
  DEFAULT_REMOTE_CONTROL_ALLOWLIST,
  DEFAULT_REMOTE_CONTROL_CONFIG,
  DEFAULT_REMOTE_CONTROL_PORT,
  DEFAULT_REMOTE_CONTROL_RATE_LIMIT_PER_MIN,
  DEFAULT_TOKEN_CAPABILITY,
  DEFAULT_WEBHOOK_DELIVERY,
  OUTBOUND_EVENT_TYPES,
  REMOTE_COMMAND_TARGETS,
  REMOTE_CONTROL_RECENT_CALLS_LIMIT,
  SENSITIVE_REMOTE_COMMAND_TARGETS,
  WEBHOOK_DELIVERY_BOUNDS,
  endpointSubscribesTo,
  groupRemoteCommandTargets,
  isLoopbackAllowlistEntry,
  isRemoteCommandTarget,
  isRemoteCommandTargetEnabled,
  isSensitiveRemoteCommandTarget,
  normalizeWebhookDelivery,
  validateCidrOrIp,
  type WebhookEgressEndpoint,
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
      delivery: DEFAULT_WEBHOOK_DELIVERY,
    })
    expect(DEFAULT_REMOTE_CONTROL_CONFIG.inbound.disabledTargets).toEqual([])
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
    expect(REMOTE_COMMAND_TARGETS).toContain("terminal.exec")
    expect(REMOTE_COMMAND_TARGETS).toContain("plugin.enable")
    expect(REMOTE_COMMAND_TARGETS).toContain("plugin.disable")
    expect(REMOTE_COMMAND_TARGETS).toHaveLength(17)
    expect(isRemoteCommandTarget("plan.run")).toBe(true)
    expect(isRemoteCommandTarget("team.dispatch")).toBe(true)
    expect(isRemoteCommandTarget("nope")).toBe(false)
  })

  it("flags only the model-cost / off-device / host-command targets as sensitive", () => {
    expect(SENSITIVE_REMOTE_COMMAND_TARGETS).toEqual([
      "chat.send",
      "connector.send",
      "goal.create",
      "terminal.exec",
    ])
    expect(isSensitiveRemoteCommandTarget("chat.send")).toBe(true)
    expect(isSensitiveRemoteCommandTarget("connector.send")).toBe(true)
    expect(isSensitiveRemoteCommandTarget("goal.create")).toBe(true)
    expect(isSensitiveRemoteCommandTarget("terminal.exec")).toBe(true)
    // Side-effect-free targets are not sensitive.
    expect(isSensitiveRemoteCommandTarget("workflow.run")).toBe(false)
    expect(isSensitiveRemoteCommandTarget("goal.pause")).toBe(false)
    expect(isSensitiveRemoteCommandTarget("plugin.enable")).toBe(false)
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

describe("groupRemoteCommandTargets", () => {
  it("groups every target by subsystem, covering all of them exactly once", () => {
    const groups = groupRemoteCommandTargets()
    const flat = groups.flatMap((g) => g.targets)
    // Every known target appears exactly once, order preserved.
    expect(flat).toEqual([...REMOTE_COMMAND_TARGETS])
    // Group segment is the substring before the first dot.
    for (const { group, targets } of groups) {
      for (const target of targets) expect(target.split(".")[0]).toBe(group)
    }
    // Multi-target subsystems collapse into one group.
    const scheduler = groups.find((g) => g.group === "scheduler")
    expect(scheduler?.targets).toEqual(["scheduler.task.run", "scheduler.event"])
  })
})

describe("isRemoteCommandTargetEnabled", () => {
  it("treats an undefined / empty denylist as everything enabled", () => {
    expect(isRemoteCommandTargetEnabled(undefined, "workflow.run")).toBe(true)
    expect(isRemoteCommandTargetEnabled([], "workflow.run")).toBe(true)
  })

  it("disables only the exact listed targets", () => {
    const denied = ["plugin.disable", "terminal.exec"]
    expect(isRemoteCommandTargetEnabled(denied, "plugin.disable")).toBe(false)
    expect(isRemoteCommandTargetEnabled(denied, "terminal.exec")).toBe(false)
    expect(isRemoteCommandTargetEnabled(denied, "workflow.run")).toBe(true)
    // A prefix must not partially match.
    expect(isRemoteCommandTargetEnabled(denied, "plugin")).toBe(true)
  })
})

describe("endpointSubscribesTo", () => {
  const base: WebhookEgressEndpoint = {
    id: "ep",
    name: "n",
    url: "https://x.test",
    headers: [],
    enabled: true,
  }

  it("receives everything when the filter is missing or empty", () => {
    expect(endpointSubscribesTo(base, "complete")).toBe(true)
    expect(endpointSubscribesTo({ ...base, eventTypes: [] }, "complete")).toBe(true)
  })

  it("receives only subscribed event types when a filter is set", () => {
    const ep = { ...base, eventTypes: ["complete", "error"] }
    expect(endpointSubscribesTo(ep, "complete")).toBe(true)
    expect(endpointSubscribesTo(ep, "error")).toBe(true)
    expect(endpointSubscribesTo(ep, "start")).toBe(false)
  })

  it("exposes the known lifecycle event types", () => {
    expect(OUTBOUND_EVENT_TYPES).toEqual(["start", "progress", "complete", "error", "auto-paused"])
  })
})

describe("normalizeWebhookDelivery", () => {
  it("fills defaults for a missing config", () => {
    expect(normalizeWebhookDelivery()).toEqual(DEFAULT_WEBHOOK_DELIVERY)
    expect(normalizeWebhookDelivery({})).toEqual(DEFAULT_WEBHOOK_DELIVERY)
  })

  it("clamps out-of-range values into the accepted bounds", () => {
    const low = normalizeWebhookDelivery({ maxRetries: -5, timeoutMs: 10, baseDelayMs: 1 })
    expect(low).toEqual({
      maxRetries: WEBHOOK_DELIVERY_BOUNDS.maxRetries.min,
      timeoutMs: WEBHOOK_DELIVERY_BOUNDS.timeoutMs.min,
      baseDelayMs: WEBHOOK_DELIVERY_BOUNDS.baseDelayMs.min,
    })
    const high = normalizeWebhookDelivery({
      maxRetries: 999,
      timeoutMs: 999_999,
      baseDelayMs: 999_999,
    })
    expect(high).toEqual({
      maxRetries: WEBHOOK_DELIVERY_BOUNDS.maxRetries.max,
      timeoutMs: WEBHOOK_DELIVERY_BOUNDS.timeoutMs.max,
      baseDelayMs: WEBHOOK_DELIVERY_BOUNDS.baseDelayMs.max,
    })
  })

  it("rounds fractional inputs and ignores NaN", () => {
    expect(normalizeWebhookDelivery({ maxRetries: 2.7 }).maxRetries).toBe(3)
    expect(normalizeWebhookDelivery({ timeoutMs: Number.NaN }).timeoutMs).toBe(
      DEFAULT_WEBHOOK_DELIVERY.timeoutMs
    )
  })
})
