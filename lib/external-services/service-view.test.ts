/**
 * @jest-environment node
 */
import { buildServiceViews, orphanServiceConnections } from "./service-view"
import type { RegisteredExternalService } from "./catalog"
import type { ServiceConnection, ServiceConnectionStatus } from "@/types/external-service"

/** The bundled Figma manifest, trimmed to what this projection reads. */
const figma: RegisteredExternalService = {
  pluginId: "figma-external-service",
  definition: {
    id: "figma",
    label: "Figma",
    description: "Design context and canvas editing.",
    icon: "🎨",
    skillIds: ["figma-use", "figma-design-to-code"],
    fallbackPolicy: "never",
    providers: [
      {
        id: "remote",
        kind: "mcp",
        contributionId: "figma-remote",
        priority: 100,
        surfaces: ["chat", "workflow"],
        availability: "vendor-pending",
      },
      {
        id: "desktop",
        kind: "mcp",
        contributionId: "figma-desktop",
        priority: 90,
        surfaces: ["chat", "workflow"],
        availability: "supported",
      },
    ],
  },
}

function connection(
  providerId: string,
  status: ServiceConnectionStatus,
  serverId = `srv-${providerId}`
): ServiceConnection {
  return {
    id: `plugin:figma-external-service:figma:${providerId}:account`,
    pluginId: "figma-external-service",
    serviceId: "figma",
    providerId,
    runtimeTargetId: "local",
    accountLabel: `Figma ${providerId}`,
    status,
    providerFingerprint: "fp",
    providerRef: { kind: "mcp", serverId },
    enabledSurfaces: ["chat"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("buildServiceViews", () => {
  it("keeps one entry per service rather than one per provider", () => {
    // The defect this replaces: Figma showed up as two unrelated flat rows.
    const [view] = buildServiceViews([figma], [connection("remote", "pending")])
    expect(view.key).toBe("figma-external-service:figma")
    expect(view.label).toBe("Figma")
    expect(view.providers).toHaveLength(2)
  })

  it("orders providers by descending priority, the order the router tries", () => {
    const [view] = buildServiceViews([figma], [])
    expect(view.providers.map((p) => p.providerId)).toEqual(["remote", "desktop"])
  })

  it("sends a pending managed MCP connection to its server review", () => {
    const [view] = buildServiceViews([figma], [connection("desktop", "pending", "srv-1")])
    const desktop = view.providers.find((p) => p.providerId === "desktop")
    expect(desktop?.action).toEqual({ kind: "review", serverId: "srv-1" })
    expect(view.awaitingReview).toBe(true)
    expect(view.connected).toBe(false)
  })

  it("treats needs-auth as a review too, not as a dead end", () => {
    const [view] = buildServiceViews([figma], [connection("desktop", "needs-auth", "srv-1")])
    expect(view.providers.find((p) => p.providerId === "desktop")?.action).toEqual({
      kind: "review",
      serverId: "srv-1",
    })
  })

  it("switches to manage once the connection is live", () => {
    const [view] = buildServiceViews([figma], [connection("desktop", "connected", "srv-1")])
    expect(view.providers.find((p) => p.providerId === "desktop")?.action).toEqual({
      kind: "manage",
      serverId: "srv-1",
    })
    expect(view.connected).toBe(true)
    expect(view.awaitingReview).toBe(false)
  })

  it("is connected as soon as ONE interchangeable provider is", () => {
    const [view] = buildServiceViews(
      [figma],
      [connection("remote", "pending"), connection("desktop", "connected")]
    )
    expect(view.connected).toBe(true)
  })

  it("offers resume, not review, for a paused connection", () => {
    const [view] = buildServiceViews([figma], [connection("desktop", "suspended")])
    expect(view.providers.find((p) => p.providerId === "desktop")?.action).toEqual({
      kind: "resume",
    })
  })

  it("names the vendor as the blocker when nothing was provisioned", () => {
    // `vendor-pending` with no connection row is the resting state for Figma
    // Remote. A button here would fail, so the row says who we are waiting on.
    const [view] = buildServiceViews([figma], [])
    expect(view.providers.find((p) => p.providerId === "remote")?.action).toEqual({
      kind: "blocked-upstream",
    })
    expect(view.providers.find((p) => p.providerId === "desktop")?.action).toEqual({ kind: "none" })
  })

  it("reports not-connected as a state distinct from any connection status", () => {
    const [view] = buildServiceViews([figma], [])
    expect(view.providers.map((p) => p.state)).toEqual(["not-connected", "not-connected"])
  })

  it("defaults an undeclared availability to supported", () => {
    const bare: RegisteredExternalService = {
      pluginId: "p",
      definition: {
        id: "s",
        label: "S",
        fallbackPolicy: "never",
        providers: [
          { id: "only", kind: "mcp", contributionId: "c", priority: 1, surfaces: ["chat"] },
        ],
      },
    }
    expect(buildServiceViews([bare], [])[0].providers[0].availability).toBe("supported")
  })

  it("ignores a connection belonging to a different service", () => {
    const foreign: ServiceConnection = { ...connection("desktop", "connected"), serviceId: "other" }
    const [view] = buildServiceViews([figma], [foreign])
    expect(view.connected).toBe(false)
    expect(view.providers.every((p) => p.connection === null)).toBe(true)
  })
})

describe("orphanServiceConnections", () => {
  const website: ServiceConnection = {
    id: "user:site",
    serviceId: "acme-admin",
    providerId: "browser",
    runtimeTargetId: "local",
    accountLabel: "Acme Admin",
    status: "connected",
    providerFingerprint: "fp",
    providerRef: {
      kind: "browser",
      profileId: "p",
      workspaceId: "w",
      allowedDomains: ["acme.com"],
      allowUploads: false,
      allowDownloads: false,
    },
    enabledSurfaces: ["chat"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }

  it("keeps a hand-connected website, which has no catalog definition", () => {
    expect(orphanServiceConnections([figma], [website])).toEqual([website])
  })

  it("keeps a row whose owning plugin no longer declares that provider", () => {
    // Uninstalling a plugin can leave rows behind. This section is the only
    // place they can still be seen and paused.
    const stale = { ...connection("gone", "connected") }
    expect(orphanServiceConnections([figma], [stale])).toEqual([stale])
  })

  it("drops rows the catalog does account for", () => {
    expect(orphanServiceConnections([figma], [connection("desktop", "connected")])).toEqual([])
  })
})
