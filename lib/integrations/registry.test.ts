import type {
  IntegrationActionHandler,
  IntegrationEventNormalizer,
  PluginIntegrationDef,
} from "@/types/plugin/plugin-integration"
import {
  __resetIntegrationRegistryForTesting,
  getIntegrationActionHandler,
  getIntegrationEventNormalizer,
  getRegisteredIntegration,
  listRegisteredIntegrationEntries,
  listRegisteredIntegrations,
  registerIntegrationDefinitions,
  unregisterIntegrationsByPlugin,
} from "./registry"

const handler: IntegrationActionHandler = async () => ({ ok: true })
const normalizer: IntegrationEventNormalizer = async () => []

function definition(overrides: Partial<PluginIntegrationDef> = {}): PluginIntegrationDef {
  return {
    id: "issues",
    label: "Issues",
    authStrategies: [],
    resourceKinds: ["issue"],
    eventTypes: [],
    actions: [
      {
        id: "create",
        label: "Create issue",
        handler: "createIssue",
        inputSchema: {},
        risk: "write",
        idempotency: "supported",
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  __resetIntegrationRegistryForTesting()
})

describe("integration registry", () => {
  it("registers definitions, handlers, normalizers, and filtered listings", () => {
    const issues = definition({
      ingress: {
        normalizer: "normalizeIssue",
        verification: { type: "static-token", tokenHeader: "x-hook-token" },
      },
    })
    registerIntegrationDefinitions({
      pluginId: "plugin-a",
      definitions: [issues],
      handlers: { "issues:create": handler },
      normalizers: { issues: normalizer },
    })
    registerIntegrationDefinitions({
      pluginId: "plugin-b",
      definitions: [definition({ id: "tasks", label: "Tasks" })],
      handlers: { "tasks:create": handler },
    })

    expect(getRegisteredIntegration("plugin-a", "issues")?.definition).toBe(issues)
    expect(getIntegrationActionHandler("plugin-a", "issues", "create")).toBe(handler)
    expect(getIntegrationEventNormalizer("plugin-a", "issues")).toBe(normalizer)
    expect(listRegisteredIntegrations("plugin-a")).toEqual([issues])
    expect(listRegisteredIntegrationEntries()).toHaveLength(2)
    expect(unregisterIntegrationsByPlugin("plugin-a")).toBe(1)
    expect(listRegisteredIntegrations()).toHaveLength(1)
  })

  it("rejects unresolved action handlers", () => {
    expect(() =>
      registerIntegrationDefinitions({
        pluginId: "plugin",
        definitions: [definition()],
        handlers: {},
      })
    ).toThrow('Integration "issues" action "create" has no resolved handler')
  })

  it("rejects unresolved ingress normalizers", () => {
    expect(() =>
      registerIntegrationDefinitions({
        pluginId: "plugin",
        definitions: [
          definition({
            ingress: {
              normalizer: "normalizeIssue",
              verification: { type: "static-token", tokenHeader: "x-hook-token" },
            },
          }),
        ],
        handlers: { "issues:create": handler },
      })
    ).toThrow('Integration "issues" has no resolved ingress normalizer')
  })
})
