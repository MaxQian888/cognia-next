import { TemplateCatalog } from "@/lib/templates/catalog"
import { canonicalTemplateStringify, createTemplateDefinition } from "@/lib/templates/contracts"
import { sha256Hex } from "@/lib/share/hash"
import {
  createTemplatesAPI,
  registerLegacyPluginTemplateCompatibility,
  registerPluginTemplatePackages,
  clearTemplatesForPluginContext,
} from "./templates-api"

async function pluginTemplate() {
  return createTemplateDefinition({
    id: "demo.plugin:skill.summary",
    domain: "skill",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Summary" },
    payload: { content: "Summarize" },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "plugin", pluginId: "demo.plugin", trust: "unsigned" },
  })
}

describe("PluginTemplatesAPI", () => {
  it("scopes dynamic registrations to the contributing plugin lifecycle", async () => {
    const catalog = new TemplateCatalog()
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: {} as never,
      hasPermission: () => true,
      confirm: async () => true,
    })
    const dispose = api.register(await pluginTemplate())

    expect(api.list().map((definition) => definition.id)).toEqual(["demo.plugin:skill.summary"])
    dispose()
    expect(api.list()).toEqual([])
  })

  it("exposes a live read-only catalog and tears subscriptions down with the plugin", async () => {
    const catalog = new TemplateCatalog()
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: {} as never,
      hasPermission: () => true,
      confirm: async () => true,
    })
    const listener = jest.fn()
    api.subscribe(listener)
    api.register(await pluginTemplate())

    expect(api.getRevision()).toBe(1)
    expect(api.get("demo.plugin:skill.summary")?.domain).toBe("skill")
    expect(api.query({ domain: "skill" })).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)

    clearTemplatesForPluginContext("demo.plugin", catalog)
    catalog.replaceSource("later", [await pluginTemplate()])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("rejects spoofed plugin provenance and missing permissions", async () => {
    const catalog = new TemplateCatalog()
    const denied = createTemplatesAPI("demo.plugin", {
      catalog,
      service: {} as never,
      hasPermission: () => false,
      confirm: async () => true,
    })
    expect(() => denied.list()).toThrow(/templates:read/)

    const allowed = createTemplatesAPI("demo.plugin", {
      catalog,
      service: {} as never,
      hasPermission: () => true,
      confirm: async () => true,
    })
    const spoofed = {
      ...(await pluginTemplate()),
      provenance: { source: "plugin" as const, pluginId: "another.plugin" },
    }
    expect(() => allowed.register(spoofed)).toThrow(/provenance/i)
  })

  it("requires both permission and user confirmation before instantiation", async () => {
    const catalog = new TemplateCatalog()
    const instantiate = jest.fn(async () => ({ resources: [], rollbackToken: null }))
    const confirm = jest.fn(async () => false)
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: { instantiate } as never,
      hasPermission: (permission) => permission === "templates:instantiate",
      confirm,
    })

    await expect(
      api.instantiate({
        plan: {
          id: "plan-1",
          definitionId: "demo.plugin:skill.summary",
          definitionHash: "a".repeat(64),
          status: "needs-confirmation",
          bindings: [],
          issues: [],
          operations: [],
          requiresConfirmation: true,
        },
        confirmed: true,
      })
    ).rejects.toThrow(/preflight/i)
    expect(instantiate).not.toHaveBeenCalled()
  })

  it("requires the dedicated write permission and confirmation for user drafts", async () => {
    const catalog = new TemplateCatalog()
    const createDraft = jest.fn(async (input) => ({ ...input, id: input.id }))
    const confirm = jest.fn(async () => true)
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: { createDraft } as never,
      hasPermission: (permission) => permission === "templates:library:write",
      confirm,
    })
    const input = {
      id: "skill.from-plugin",
      domain: "skill" as const,
      metadata: { name: "From plugin" },
      payload: { content: "Portable" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop" as const] },
    }

    await api.createDraft(input)

    expect(confirm).toHaveBeenCalledWith({
      pluginId: "demo.plugin",
      action: "library-write",
      definitionId: "skill.from-plugin",
    })
    expect(createDraft).toHaveBeenCalledWith(input)
  })

  it("registers declarative packages as one lifecycle-scoped catalog source", async () => {
    const catalog = new TemplateCatalog()
    const baseDefinition = await pluginTemplate()
    const definition = await createTemplateDefinition({
      ...baseDefinition,
      provenance: {
        ...baseDefinition.provenance,
        packageId: "demo.plugin.templates",
      },
    })
    const checksum = await sha256Hex(canonicalTemplateStringify(definition as never))

    expect(
      await registerPluginTemplatePackages(
        "demo.plugin",
        [
          {
            manifest: {
              schemaVersion: 1,
              apiVersion: definition.apiVersion,
              id: "demo.plugin.templates",
              version: "1.0.0",
              name: "Demo templates",
              entrypoints: [`${definition.id}@${definition.version}`],
              definitions: [
                {
                  id: definition.id,
                  version: definition.version!,
                  path: "definitions/skill.json",
                  sha256: checksum,
                },
              ],
              assets: [],
            },
            definitions: [definition],
          },
        ],
        catalog
      )
    ).toBe(1)
    expect(catalog.getSnapshot().definitions).toHaveLength(1)
  })

  it("does not let template permission escalate domain capabilities", async () => {
    const catalog = new TemplateCatalog()
    const definition = { ...(await pluginTemplate()), capabilities: ["network"] }
    catalog.replaceSource("plugin:demo.plugin", [definition])
    const instantiate = jest.fn(async () => ({ resources: [] }))
    const preflight = jest.fn(async () => ({
      id: "plan-capability",
      definitionId: definition.id,
      definitionHash: definition.contentHash,
      definition,
      status: "ready" as const,
      bindings: [],
      issues: [],
      operations: [],
      requiresConfirmation: false,
    }))
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: { preflight, instantiate } as never,
      hasPermission: (permission) =>
        permission === "templates:read" || permission === "templates:instantiate",
      confirm: async () => true,
    })

    const plan = await api.preflight({
      definitionId: definition.id,
      version: definition.version!,
      platform: "desktop",
      bindings: {},
    })

    expect(plan.status).toBe("blocked")
    expect(plan.issues).toEqual([
      expect.objectContaining({
        code: "plugin.permission-missing",
        severity: "blocker",
      }),
    ])
    await expect(api.instantiate({ plan, confirmed: true })).rejects.toThrow(
      /blocked|permission|preflight/i
    )
    expect(instantiate).not.toHaveBeenCalled()
  })

  it("returns opaque sensitive bindings while retaining the host plan for instantiation", async () => {
    const catalog = new TemplateCatalog()
    const definition = await pluginTemplate()
    catalog.replaceSource("plugin:demo.plugin", [definition])
    const internalPlan = {
      id: "plan-secret",
      definitionId: definition.id,
      definitionHash: definition.contentHash,
      definition,
      status: "needs-confirmation" as const,
      bindings: [
        {
          slotId: "twin",
          kind: "twinSlot",
          resourceId: "local-private-twin-id",
          sensitive: true,
        },
      ],
      issues: [],
      operations: [
        {
          id: "create:retained-resource",
          kind: "create",
          domain: "skill",
          summary: "Create the retained host resource",
        },
      ],
      requiresConfirmation: true,
    }
    const instantiate = jest.fn(async () => ({ resources: [] }))
    const confirm = jest.fn(async () => true)
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: {
        preflight: async () => internalPlan,
        instantiate,
      } as never,
      hasPermission: () => true,
      confirm,
    })

    const publicPlan = await api.preflight({
      definitionId: definition.id,
      version: definition.version!,
      platform: "desktop",
      bindings: { twin: "local-private-twin-id" },
    })
    expect(publicPlan.bindings[0].resourceId).toBe("twinSlot:bound")
    publicPlan.definitionId = "demo.plugin:skill.decoy"
    publicPlan.operations = [
      {
        id: "create:decoy",
        kind: "create",
        domain: "skill",
        summary: "Harmless decoy operation",
      },
    ]

    await api.instantiate({ plan: publicPlan, confirmed: true })
    expect(confirm).toHaveBeenCalledWith({
      pluginId: "demo.plugin",
      action: "instantiate",
      definitionId: definition.id,
      operations: ["Create the retained host resource"],
    })
    expect(instantiate).toHaveBeenCalledWith({
      plan: internalPlan,
      confirmed: true,
    })
  })

  it("routes deprecated AgentTeam helpers through the unified validator", async () => {
    const catalog = new TemplateCatalog()

    await registerLegacyPluginTemplateCompatibility({
      pluginId: "demo.plugin",
      catalog,
      agentTeams: [
        {
          id: "review",
          name: "Review",
          description: "Review a change",
          category: "review",
          teammates: [{ name: "Reviewer", description: "Reviews" }],
        },
      ],
    })

    expect(catalog.get("demo.plugin:review", "0.0.0-compat")).toMatchObject({
      domain: "agentTeam",
      status: "published",
      provenance: { pluginId: "demo.plugin" },
    })
  })
})
