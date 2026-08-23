import type { ExternalCapability } from "@/types/external-service"
import type { PluginServiceDef } from "@/types/plugin/plugin-service"

import {
  __resetExternalServiceCatalogForTesting,
  registerExternalCapabilities,
  registerExternalServices,
} from "./catalog"
import { resolveCapabilityRoute } from "./routing"

const service = (fallbackPolicy: "never" | "confirm" = "confirm"): PluginServiceDef => ({
  id: "github",
  label: "GitHub",
  fallbackPolicy,
  providers: [
    {
      id: "api",
      kind: "integration",
      contributionId: "github-api",
      priority: 100,
      surfaces: ["chat", "workflow"],
    },
    {
      id: "web",
      kind: "browser",
      contributionId: "github-web",
      priority: 10,
      surfaces: ["chat"],
    },
    {
      id: "pending",
      kind: "mcp",
      contributionId: "github-mcp",
      priority: 200,
      surfaces: ["chat"],
      availability: "vendor-pending",
    },
  ],
})

function capability(providerId: string, id: string, operationId: string): ExternalCapability {
  return {
    pluginId: "builtin",
    serviceId: "github",
    providerId,
    capabilityId: id,
    operationId,
    kind: "action",
    risk: "write",
    surfaces: ["chat"],
  }
}

beforeEach(() => __resetExternalServiceCatalogForTesting())

describe("external capability routing", () => {
  it("prefers the selected semantic provider and ignores vendor-pending providers", () => {
    registerExternalServices("builtin", [service()])
    registerExternalCapabilities("builtin", "github", "api", [
      capability("api", "create-issue", "github.issue.create"),
    ])
    registerExternalCapabilities("builtin", "github", "pending", [
      capability("pending", "create-issue", "github.issue.create"),
    ])
    expect(
      resolveCapabilityRoute({
        pluginId: "builtin",
        serviceId: "github",
        operationId: "github.issue.create",
        surface: "chat",
        preferredProviderId: "api",
        browserFallbackConfirmed: false,
      })
    ).toEqual({ status: "resolved", providerId: "api", capabilityId: "create-issue" })
  })

  it("only offers browser fallback for an equivalent operation after confirmation", () => {
    registerExternalServices("builtin", [service()])
    registerExternalCapabilities("builtin", "github", "web", [
      capability("web", "create-issue-web", "github.issue.create"),
      capability("web", "unrelated", "github.unrelated"),
    ])
    const input = {
      pluginId: "builtin",
      serviceId: "github",
      operationId: "github.issue.create",
      surface: "chat" as const,
      unavailableProviderIds: ["api"],
    }
    expect(resolveCapabilityRoute({ ...input, browserFallbackConfirmed: false })).toEqual({
      status: "confirmation-required",
      providerId: "web",
      capabilityId: "create-issue-web",
      reason: "browser-fallback",
    })
    expect(resolveCapabilityRoute({ ...input, browserFallbackConfirmed: true })).toEqual({
      status: "resolved",
      providerId: "web",
      capabilityId: "create-issue-web",
    })
  })

  it("fails closed when fallback is disabled, the surface mismatches, or service is absent", () => {
    registerExternalServices("builtin", [service("never")])
    registerExternalCapabilities("builtin", "github", "web", [
      capability("web", "create-issue-web", "github.issue.create"),
    ])
    expect(
      resolveCapabilityRoute({
        pluginId: "builtin",
        serviceId: "github",
        operationId: "github.issue.create",
        surface: "chat",
        browserFallbackConfirmed: true,
      })
    ).toEqual({ status: "unavailable", reason: "fallback-disabled" })
    expect(
      resolveCapabilityRoute({
        pluginId: "builtin",
        serviceId: "github",
        operationId: "github.issue.create",
        surface: "workflow",
        browserFallbackConfirmed: true,
      })
    ).toEqual({ status: "unavailable", reason: "no-provider" })
    expect(
      resolveCapabilityRoute({
        pluginId: "missing",
        serviceId: "github",
        operationId: "github.issue.create",
        surface: "chat",
        browserFallbackConfirmed: false,
      })
    ).toEqual({ status: "unavailable", reason: "service-not-found" })
  })
})
