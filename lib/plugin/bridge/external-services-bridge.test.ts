import type { PluginManifest } from "@/types/plugin"

import {
  __resetExternalServiceCatalogForTesting,
  listExternalCapabilities,
  listExternalServices,
} from "@/lib/external-services/catalog"
import {
  registerExternalServicesForPlugin,
  unregisterExternalServicesForPlugin,
} from "./external-services-bridge"

beforeEach(() => __resetExternalServiceCatalogForTesting())

function manifest(): PluginManifest {
  return {
    id: "delivery",
    name: "Delivery",
    version: "1.0.0",
    type: "frontend",
    main: "index.ts",
    capabilities: ["integrations"],
    integrations: [
      {
        id: "github",
        label: "GitHub",
        authStrategies: [],
        resourceKinds: ["issue"],
        eventTypes: [{ id: "issue.updated", label: "Issue updated", resourceKinds: ["issue"] }],
        actions: [
          {
            id: "createIssue",
            operationId: "issue.create",
            label: "Create issue",
            handler: "createIssue",
            inputSchema: { type: "object" },
            risk: "write",
            idempotency: "supported",
          },
        ],
      },
    ],
    browserSiteProviders: [
      {
        id: "github-web",
        label: "GitHub Web",
        allowedDomains: ["github.com"],
        operations: [
          {
            id: "create-issue-web",
            operationId: "issue.create",
            label: "Create issue in browser",
            risk: "write",
          },
        ],
      },
    ],
    services: [
      {
        id: "github",
        label: "GitHub",
        fallbackPolicy: "confirm",
        providers: [
          {
            id: "api",
            kind: "integration",
            contributionId: "github",
            priority: 100,
            surfaces: ["chat", "workflow", "inbox"],
          },
          {
            id: "web",
            kind: "browser",
            contributionId: "github-web",
            priority: 10,
            surfaces: ["chat"],
          },
        ],
      },
    ],
  }
}

describe("external services plugin bridge", () => {
  it("projects integration and browser contributions into the capability catalog", () => {
    registerExternalServicesForPlugin("delivery", manifest())

    expect(listExternalServices("delivery")).toHaveLength(1)
    expect(listExternalCapabilities({ serviceId: "github" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "api",
          capabilityId: "createIssue",
          operationId: "issue.create",
          kind: "action",
          risk: "write",
        }),
        expect.objectContaining({
          providerId: "web",
          capabilityId: "create-issue-web",
          operationId: "issue.create",
          kind: "action",
        }),
        expect.objectContaining({ providerId: "api", capabilityId: "resource:issue" }),
        expect.objectContaining({ providerId: "api", capabilityId: "event:issue.updated" }),
      ])
    )

    expect(unregisterExternalServicesForPlugin("delivery")).toBe(1)
    expect(listExternalCapabilities()).toEqual([])
  })

  it("fails closed and rolls back when a provider contribution is missing", () => {
    const invalid = manifest()
    invalid.services![0].providers[0].contributionId = "missing"

    expect(() => registerExternalServicesForPlugin("delivery", invalid)).toThrow(
      'references missing integration contribution "missing"'
    )
    expect(listExternalServices()).toEqual([])
  })

  it("creates a temporary service projection for legacy integration manifests", () => {
    const legacy = manifest()
    delete legacy.services
    registerExternalServicesForPlugin("delivery", legacy)

    expect(listExternalServices("delivery")).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({
          id: "github",
          providers: [expect.objectContaining({ id: "integration", kind: "integration" })],
        }),
      }),
    ])
  })
})
