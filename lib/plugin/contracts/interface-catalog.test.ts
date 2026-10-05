import {
  clearPluginApiAuditEvents,
  evaluatePluginApiCall,
  getRecentPluginApiAuditEvents,
  getPluginApiMethodContract,
  listPluginApiMethodContracts,
  recordPluginApiAudit,
  subscribePluginApiAudit,
} from "./interface-catalog"

describe("plugin interface catalog", () => {
  beforeEach(() => clearPluginApiAuditEvents())

  it("indexes the canonical ctx method surface", () => {
    // A canary, not a fact worth memorising: any catalog edit lands here so
    // the method surface cannot grow or shrink without someone noticing.
    expect(listPluginApiMethodContracts()).toHaveLength(876)
    // ADR-0216: external-agent configurations — reads gated by read, every
    // write by the dangerous manage permission, the feed a scope-owned disposer.
    expect(getPluginApiMethodContract("externalAgents.list")).toMatchObject({
      requiredPermissions: ["agent:external:read"],
      namespace: { runtimes: ["frontend", "hybrid", "python"] },
    })
    expect(getPluginApiMethodContract("externalAgents.onChange")).toMatchObject({
      requiredPermissions: ["agent:external:read"],
      resourceEffect: { kind: "returned-disposer" },
    })
    expect(getPluginApiMethodContract("externalAgents.update")).toMatchObject({
      requiredPermissions: ["agent:external:manage"],
      risk: "high",
    })
    // These return void; the host releases what they registered on disable.
    expect(getPluginApiMethodContract("agent.registerExternalAgentPreset")).toMatchObject({
      resourceEffect: { kind: "host-owned" },
    })
    expect(getPluginApiMethodContract("agent.registerExternalAgentAdapter")).toMatchObject({
      resourceEffect: { kind: "host-owned" },
    })
    // The scheduler surfaces: plugin-owned tasks are capability-gated, the
    // user's schedule is permission-gated and reachable from python.
    expect(getPluginApiMethodContract("scheduler.onExecution")).toMatchObject({
      resourceEffect: { kind: "returned-disposer" },
    })
    expect(getPluginApiMethodContract("scheduler.runTaskNow")).toMatchObject({ risk: "medium" })
    expect(getPluginApiMethodContract("userScheduler.cancelExecution")).toMatchObject({
      requiredPermissions: ["agent:control", "database:write"],
      namespace: { runtimes: ["frontend", "hybrid", "python"] },
    })
    expect(getPluginApiMethodContract("userScheduler.getUpcoming")).toMatchObject({
      requiredPermissions: ["database:read"],
    })
    // The one opener for a `location: "panel"` view container; guarded, not free.
    expect(getPluginApiMethodContract("ui.openViewContainer")).toMatchObject({
      requiredPermissions: ["extension:ui"],
      namespace: { authorPath: "ctx.ui" },
    })
    expect(
      [
        "bots.getInstallation",
        "bots.enqueue",
        "bots.cancelResource",
        "bots.recordMonitor",
        "workspace.snapshot",
        "workspace.publish",
      ].every((method) => getPluginApiMethodContract(method))
    ).toBe(true)
    expect(getPluginApiMethodContract("session.listSessions")).toMatchObject({
      name: "listSessions",
      namespace: { authorPath: "ctx.session" },
    })
    expect(getPluginApiMethodContract("auth.registerProvider")).toMatchObject({
      requiredPermissions: ["auth:provide"],
      namespace: { dataClassification: "secret" },
    })
    expect(getPluginApiMethodContract("templates.instantiate")).toMatchObject({
      consentTier: "confirm",
      requiredPermissions: ["templates:instantiate"],
    })
    expect(getPluginApiMethodContract("media.video.export")).toMatchObject({
      requiredPermissions: ["media:video:export"],
    })
    // `ctx.logs` splits its own surface: operational log reads and span reads
    // are separate grants, because spans can carry model input/output.
    expect(getPluginApiMethodContract("logs.query")).toMatchObject({
      requiredPermissions: ["logs:read"],
      namespace: { authorPath: "ctx.logs", dataClassification: "sensitive" },
    })
    expect(getPluginApiMethodContract("logs.traces.timeline")).toMatchObject({
      name: "traces.timeline",
      requiredPermissions: ["trace:read"],
    })
  })

  it("fails closed for unmapped calls and reports missing permissions", () => {
    expect(
      evaluatePluginApiCall({
        methodId: "missing.call",
        runtime: "frontend",
        platform: "desktop",
        hasPermission: () => true,
      })
    ).toMatchObject({ allowed: false, mode: "active", reason: "unmapped" })
    expect(
      evaluatePluginApiCall({
        methodId: "session.listSessions",
        runtime: "frontend",
        platform: "desktop",
        hasPermission: () => false,
      })
    ).toMatchObject({
      allowed: false,
      mode: "shadow",
      reason: "permission",
      missingPermissions: ["session:read"],
    })
  })

  it("audits metadata without accepting payload content", () => {
    const listener = jest.fn()
    const unsubscribe = subscribePluginApiAudit(listener)
    recordPluginApiAudit({
      pluginId: "example",
      methodId: "session.listSessions",
      runtime: "frontend",
      outcome: "allowed",
      durationMs: 2,
      dataClassification: "sensitive",
    })
    unsubscribe()
    expect(listener).toHaveBeenCalledWith(
      expect.not.objectContaining({ args: expect.anything(), data: expect.anything() })
    )
  })

  it("isolates API behavior from failing audit subscribers", () => {
    const healthyListener = jest.fn()
    const unsubscribeFailing = subscribePluginApiAudit(() => {
      throw new Error("telemetry unavailable")
    })
    const unsubscribeHealthy = subscribePluginApiAudit(healthyListener)
    const event = {
      pluginId: "example",
      methodId: "session.listSessions",
      runtime: "frontend" as const,
      outcome: "allowed" as const,
      durationMs: 2,
      dataClassification: "sensitive" as const,
    }

    expect(() => recordPluginApiAudit(event)).not.toThrow()
    expect(healthyListener).toHaveBeenCalledWith(event)
    unsubscribeFailing()
    unsubscribeHealthy()
  })

  it("retains a bounded metadata-only audit history without a mounted subscriber", () => {
    for (let index = 0; index < 501; index += 1) {
      recordPluginApiAudit({
        pluginId: "example",
        methodId: `session.listSessions.${index}`,
        runtime: "frontend",
        outcome: "allowed",
        durationMs: index,
        dataClassification: "sensitive",
      })
    }

    const events = getRecentPluginApiAuditEvents()
    expect(events).toHaveLength(500)
    expect(events[0].methodId).toBe("session.listSessions.1")
    expect(events.at(-1)).not.toEqual(
      expect.objectContaining({ args: expect.anything(), data: expect.anything() })
    )
  })
})
