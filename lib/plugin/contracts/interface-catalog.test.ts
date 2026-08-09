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
    expect(listPluginApiMethodContracts()).toHaveLength(628)
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
