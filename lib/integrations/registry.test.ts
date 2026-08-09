import type {
  IntegrationAccountStatusProvider,
  IntegrationActionHandler,
  IntegrationEventNormalizer,
  IntegrationResourceProvider,
  PluginIntegrationDef,
} from "@/types/plugin/plugin-integration"
import {
  __resetIntegrationRegistryForTesting,
  getIntegrationActionHandler,
  getIntegrationAccountStatusProvider,
  getIntegrationEventNormalizer,
  getIntegrationResourceProvider,
  getIntegrationRegistryRevision,
  getRegisteredIntegration,
  listRegisteredIntegrationEntries,
  listRegisteredIntegrations,
  registerIntegrationDefinitions,
  subscribeIntegrationRegistry,
  unregisterIntegrationsByPlugin,
} from "./registry"

const handler: IntegrationActionHandler = async () => ({ ok: true })
const normalizer: IntegrationEventNormalizer = async () => []
const resourceProvider: IntegrationResourceProvider = async (_query, context) => ({
  items: [],
  syncedAt: `2026-08-09T00:00:00.000Z:${context.accountId}`,
})
const accountStatusProvider: IntegrationAccountStatusProvider = async () => ({
  health: "healthy",
  checkedAt: "2026-08-09T00:00:00.000Z",
})

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

  it("registers optional resource and health providers", () => {
    registerIntegrationDefinitions({
      pluginId: "plugin",
      definitions: [
        definition({
          resourceProvider: { handler: "listResources", kinds: ["issue"] },
          healthProvider: { handler: "checkHealth" },
        }),
      ],
      handlers: { "issues:create": handler },
      resourceProviders: { issues: resourceProvider },
      accountStatusProviders: { issues: accountStatusProvider },
    })

    expect(getIntegrationResourceProvider("plugin", "issues")).toBe(resourceProvider)
    expect(getIntegrationAccountStatusProvider("plugin", "issues")).toBe(accountStatusProvider)
  })

  it.each([
    ["resourceProvider", "resource provider"],
    ["healthProvider", "account status provider"],
  ] as const)("rejects an unresolved %s", (field, message) => {
    expect(() =>
      registerIntegrationDefinitions({
        pluginId: "plugin",
        definitions: [definition({ [field]: "provider" })],
        handlers: { "issues:create": handler },
      })
    ).toThrow(message)
  })

  it("notifies reactive consumers when definitions change", () => {
    const listener = jest.fn()
    const before = getIntegrationRegistryRevision()
    const unsubscribe = subscribeIntegrationRegistry(listener)

    registerIntegrationDefinitions({
      pluginId: "plugin",
      definitions: [definition()],
      handlers: { "issues:create": handler },
    })
    expect(getIntegrationRegistryRevision()).toBe(before + 1)
    expect(listener).toHaveBeenCalledTimes(1)

    unregisterIntegrationsByPlugin("plugin")
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
