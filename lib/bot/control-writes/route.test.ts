import {
  BOT_WRITE_COMMANDS,
  canEnqueueBotWrite,
  canWriteBotLifecycle,
  resolveBotLifecycleWriteAvailability,
  resolveBotWriteAvailability,
  resolveBotWriteRoute,
  __setBotWriteRouteDepsForTests,
} from "./route"

let restore: (() => void) | undefined

function setup(over: Parameters<typeof __setBotWriteRouteDepsForTests>[0]) {
  restore?.()
  restore = __setBotWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    isRunnerOwnedHere: () => false,
    hasLocalDatabase: () => false,
    getRuntimeSnapshot: (() => ({ target: null })) as never,
    activeHostFeatureManifest: () => null,
    ...over,
  })
}

afterEach(() => {
  restore?.()
  restore = undefined
})

describe("resolveBotWriteRoute", () => {
  it("routes arming locally on any shell that owns the database", () => {
    // Arming writes configuration that whichever runner picks the next
    // delivery up will read. Refusing it on a host between runners is wrong.
    setup({ hasLocalDatabase: () => true, isRunnerOwnedHere: () => false })
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.setTriggerArmed)).toBe("local")
  })

  it("refuses a manual run on a shell with a database but no runner", () => {
    // A delivery only ever moves because a runner drains it, so the write
    // would land in a queue nothing reads.
    setup({ hasLocalDatabase: () => true, isRunnerOwnedHere: () => false })
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.runManual)).toBe("unavailable")
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.replayDelivery)).toBe("unavailable")
  })

  it("routes a manual run locally once a runner is actually running here", () => {
    setup({ hasLocalDatabase: () => true, isRunnerOwnedHere: () => true })
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.runManual)).toBe("local")
  })

  it("relays from a desktop that is driving a remote host, runner or not", () => {
    // `always-on` is a static baseline that this shell still reports while
    // its own runner is stopped. Routing local here writes into a process
    // that will not execute it.
    setup({
      isRemoteHostActive: () => true,
      hasLocalDatabase: () => true,
      isRunnerOwnedHere: () => true,
    })
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.setTriggerArmed)).toBe("remote")
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.runManual)).toBe("remote")
  })

  it("relays from a companion target", () => {
    setup({ getRuntimeSnapshot: (() => ({ target: { kind: "companion" } })) as never })
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.setTriggerArmed)).toBe("remote")
  })

  it("refuses on a standalone browser with no target at all", () => {
    setup({})
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.setTriggerArmed)).toBe("unavailable")
  })
})

describe("resolveBotWriteAvailability", () => {
  it("tells a host waiting on a runner apart from a shell that cannot act", () => {
    // Two different next steps: wait, versus pair with a Host.
    setup({ hasLocalDatabase: () => true })
    expect(resolveBotWriteAvailability(BOT_WRITE_COMMANDS.runManual)).toEqual({
      state: "unsupported",
      reason: "operation-unavailable",
    })

    setup({})
    expect(resolveBotWriteAvailability(BOT_WRITE_COMMANDS.runManual)).toEqual({
      state: "unsupported",
      reason: "requires-companion",
    })
  })

  it("is available on the local route", () => {
    setup({ hasLocalDatabase: () => true })
    expect(resolveBotWriteAvailability(BOT_WRITE_COMMANDS.setTriggerArmed)).toEqual({
      state: "available",
      reason: "local-host",
    })
  })

  it("reports an incompatible remote host whose manifest has not arrived", () => {
    setup({ isRemoteHostActive: () => true, activeHostFeatureManifest: () => null })
    expect(resolveBotWriteAvailability(BOT_WRITE_COMMANDS.setTriggerArmed)).toEqual({
      state: "incompatible",
      reason: "host-manifest-missing",
    })
  })

  it("reports a remote host that does not ship the control feature", () => {
    setup({
      isRemoteHostActive: () => true,
      // A real manifest, minus this feature. Both schema versions carry the
      // `features` map, so an empty object is the shape a pre-relay host sends.
      activeHostFeatureManifest: () =>
        ({ schemaVersion: 2, features: {}, operations: [] }) as never,
    })
    expect(resolveBotWriteAvailability(BOT_WRITE_COMMANDS.setTriggerArmed)).toEqual({
      state: "unsupported",
      reason: "operation-unavailable",
    })
  })
})

describe("canEnqueueBotWrite", () => {
  it("accepts the three states a durable queue can hold", () => {
    for (const state of ["available", "queued", "offline"] as const) {
      expect(canEnqueueBotWrite({ state, reason: "local-host" })).toBe(true)
    }
    expect(canEnqueueBotWrite({ state: "unsupported", reason: "requires-companion" })).toBe(false)
  })
})

describe("resolveBotLifecycleWriteAvailability", () => {
  it("allows the lifecycle on a shell that owns the database", () => {
    setup({ hasLocalDatabase: () => true })
    expect(resolveBotLifecycleWriteAvailability()).toEqual({
      state: "available",
      reason: "local-host",
    })
    expect(canWriteBotLifecycle()).toBe(true)
  })

  it("does not need a delivery runner, unlike a manual run", () => {
    // An install is configuration. Nothing about it has to be drained.
    setup({ hasLocalDatabase: () => true, isRunnerOwnedHere: () => false })
    expect(canWriteBotLifecycle()).toBe(true)
    expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.runManual)).toBe("unavailable")
  })

  it("refuses on a desktop that is driving a remote host", () => {
    // The trap the shared ordering exists for: `always-on` is a static
    // baseline this desktop still reports while its runtimes are torn down.
    setup({
      isRemoteHostActive: () => true,
      hasLocalDatabase: () => true,
      getRuntimeSnapshot: (() => ({ target: { kind: "companion" } })) as never,
    })
    expect(resolveBotLifecycleWriteAvailability()).toEqual({
      state: "incompatible",
      reason: "host-manifest-missing",
    })
  })

  it("tells a companion it needs a Host rather than that the operation is missing", () => {
    setup({
      hasLocalDatabase: () => false,
      getRuntimeSnapshot: (() => ({ target: { kind: "companion" } })) as never,
    })
    expect(resolveBotLifecycleWriteAvailability()).toEqual({
      state: "offline",
      reason: "connection-offline",
    })
  })

  it("refuses a browser with neither a database nor a Host", () => {
    setup({ hasLocalDatabase: () => false })
    expect(resolveBotLifecycleWriteAvailability()).toEqual({
      state: "unsupported",
      reason: "requires-companion",
    })
    expect(canWriteBotLifecycle()).toBe(false)
  })
})

it("permits lifecycle writes when the paired host advertises the new operation", () => {
  setup({
    isRemoteHostActive: () => true,
    activeHostFeatureManifest: () =>
      ({
        schemaVersion: 2,
        features: { "bots.control": { version: 1, operations: ["bot_installation_mutate"] } },
        operations: [{ name: "bot_installation_mutate", healthy: true }],
      }) as never,
  })
  expect(resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation)).toBe("remote")
  expect(canWriteBotLifecycle()).toBe(true)
})
