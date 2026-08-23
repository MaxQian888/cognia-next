import type { ExternalCapability } from "@/types/external-service"
import type { PluginServiceDef } from "@/types/plugin/plugin-service"

import {
  __resetExternalServiceCatalogForTesting,
  listExternalCapabilities,
  registerExternalCapabilities,
  registerExternalServices,
  unregisterExternalServicesByPlugin,
} from "./catalog"
import { resolveCapabilityRoute } from "./routing"

const service: PluginServiceDef = {
  id: "design",
  label: "Design",
  fallbackPolicy: "confirm",
  providers: [
    {
      id: "semantic",
      kind: "mcp",
      contributionId: "design-mcp",
      priority: 100,
      surfaces: ["chat", "workflow"],
    },
    {
      id: "web",
      kind: "browser",
      contributionId: "design-web",
      priority: 10,
      surfaces: ["chat"],
    },
  ],
}

function capability(
  providerId: string,
  capabilityId: string,
  operationId?: string
): ExternalCapability {
  return {
    pluginId: "plugin-a",
    serviceId: "design",
    providerId,
    capabilityId,
    operationId,
    kind: "action",
    risk: "write",
    surfaces: ["chat"],
  }
}

beforeEach(() => __resetExternalServiceCatalogForTesting())

describe("external service capability catalog", () => {
  it("registers provider capabilities and removes them with plugin lifecycle", () => {
    registerExternalServices("plugin-a", [service])
    registerExternalCapabilities("plugin-a", "design", "semantic", [
      capability("semantic", "create", "design.create"),
    ])

    expect(listExternalCapabilities({ pluginId: "plugin-a", serviceId: "design" })).toEqual([
      expect.objectContaining({ capabilityId: "create", providerId: "semantic" }),
    ])

    expect(unregisterExternalServicesByPlugin("plugin-a")).toBe(1)
    expect(listExternalCapabilities()).toEqual([])
  })

  it("routes only declared equivalent operations", () => {
    registerExternalServices("plugin-a", [service])
    registerExternalCapabilities("plugin-a", "design", "semantic", [
      capability("semantic", "create", "design.create"),
    ])
    registerExternalCapabilities("plugin-a", "design", "web", [
      capability("web", "create-with-browser", "design.create"),
      capability("web", "unrelated"),
    ])

    const route = resolveCapabilityRoute({
      pluginId: "plugin-a",
      serviceId: "design",
      operationId: "design.create",
      surface: "chat",
      unavailableProviderIds: ["semantic"],
      browserFallbackConfirmed: false,
    })

    expect(route).toEqual({
      status: "confirmation-required",
      providerId: "web",
      capabilityId: "create-with-browser",
      reason: "browser-fallback",
    })
  })

  it("never silently downgrades to browser", () => {
    registerExternalServices("plugin-a", [{ ...service, fallbackPolicy: "never" }])
    registerExternalCapabilities("plugin-a", "design", "web", [
      capability("web", "create-with-browser", "design.create"),
    ])

    expect(
      resolveCapabilityRoute({
        pluginId: "plugin-a",
        serviceId: "design",
        operationId: "design.create",
        surface: "chat",
        browserFallbackConfirmed: true,
      })
    ).toEqual({ status: "unavailable", reason: "fallback-disabled" })
  })
})
