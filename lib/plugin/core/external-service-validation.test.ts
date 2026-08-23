import type { PluginManifest } from "@/types/plugin"

import { validatePluginManifest } from "./validation"

function manifest(): PluginManifest {
  return {
    id: "service-plugin",
    name: "Service plugin",
    description: "External service validation fixture",
    version: "1.0.0",
    type: "frontend",
    main: "index.js",
    capabilities: ["integrations"],
    integrations: [
      {
        id: "github",
        label: "GitHub",
        authStrategies: [],
        resourceKinds: [],
        eventTypes: [],
        actions: [],
      },
    ],
    browserSiteProviders: [
      {
        id: "github-web",
        label: "GitHub Web",
        allowedDomains: ["github.com"],
        operations: [
          {
            id: "create-issue",
            operationId: "issue.create",
            label: "Create issue",
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

describe("external service manifest validation", () => {
  it("accepts referenced providers with explicit Browser confirmation", () => {
    expect(validatePluginManifest(manifest()).errors).toEqual([])
  })

  it("rejects missing contributions and silent Browser fallback", () => {
    const value = manifest()
    value.services![0].providers[0].contributionId = "missing"
    value.services![0].fallbackPolicy = "never"

    expect(validatePluginManifest(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "manifest.services.provider.contribution.missing" }),
        expect.objectContaining({
          code: "manifest.services.browser_fallback.requires_confirmation",
        }),
      ])
    )
  })

  it("rejects unsafe Browser domains and remote non-HTTPS OpenAPI sources", () => {
    const value = manifest()
    value.browserSiteProviders![0].allowedDomains = ["*"]
    value.openApiProviders = [
      {
        id: "api",
        label: "API",
        source: { type: "url", url: "http://metadata.internal/spec.json" },
      },
    ]

    expect(validatePluginManifest(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest.browserSiteProviders.allowed_domains.unsafe",
        }),
        expect.objectContaining({ code: "manifest.openApiProviders.source.url.invalid" }),
      ])
    )
  })
})
