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

  it("registers a validated template batch atomically", async () => {
    const catalog = new TemplateCatalog()
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: {} as never,
      hasPermission: () => true,
      confirm: async () => true,
    })
    const first = await pluginTemplate()
    const second = await createTemplateDefinition({
      ...first,
      id: "demo.plugin:skill.extract",
      metadata: { name: "Extract" },
      payload: { content: "Extract" },
    })
    const listener = jest.fn()
    api.subscribe(listener)

    const dispose = api.registerMany([first, second])

    expect(listener).toHaveBeenCalledTimes(1)
    expect(api.list().map((definition) => definition.id)).toEqual([
      "demo.plugin:skill.extract",
      "demo.plugin:skill.summary",
    ])

    dispose()
    expect(api.list()).toEqual([])
  })

  it("does not publish a partial batch when one definition is invalid", async () => {
    const catalog = new TemplateCatalog()
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: {} as never,
      hasPermission: () => true,
      confirm: async () => true,
    })
    const valid = await pluginTemplate()
    const spoofed = {
      ...valid,
      id: "another.plugin:skill.summary",
      provenance: { ...valid.provenance, pluginId: "another.plugin" },
    }

    expect(() => api.registerMany([valid, spoofed])).toThrow(/provenance|prefixed/i)
    expect(catalog.getSnapshot().definitions).toEqual([])
    expect(catalog.getRevision()).toBe(0)
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
    const createDraft = jest.fn(async (input) => ({
      ...input,
      id: input.id,
      revision: 1,
      provenance: { source: "user", trust: "unsigned" },
    }))
    const saveDraft = jest.fn(async (input) => ({ ...input, revision: 2 }))
    const confirm = jest.fn(async () => true)
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: { createDraft, saveDraft } as never,
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

    const draft = await api.createDraft(input)

    expect(confirm).toHaveBeenCalledWith({
      pluginId: "demo.plugin",
      action: "library-write",
      definitionId: "skill.from-plugin",
    })
    expect(createDraft).toHaveBeenCalledWith(input)
    // ADR-0100 keeps the row in the user's library, so the source stays "user".
    // Authorship goes in `pluginId`, which is what every ownership refusal below
    // reads.
    expect(draft.provenance).toEqual({
      source: "user",
      trust: "unsigned",
      pluginId: "demo.plugin",
    })
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({ pluginId: "demo.plugin" }),
      }),
      1
    )
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

/**
 * The library-write half of the API. Every method here reaches
 * `TemplateService`, so the interesting behaviour is the two things the API
 * adds on top: one consent prompt, and a refusal to touch a row this plugin
 * did not create.
 */
describe("PluginTemplatesAPI library writes", () => {
  async function userDraft(overrides: Record<string, unknown> = {}) {
    return createTemplateDefinition({
      id: "skill.mine",
      domain: "skill",
      status: "draft",
      revision: 3,
      version: null,
      metadata: { name: "Mine" },
      payload: { content: "Body" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
      provenance: { source: "user", trust: "unsigned", pluginId: "demo.plugin" },
      ...overrides,
    })
  }

  function apiWith(catalog: TemplateCatalog, service: Record<string, unknown>) {
    const confirm = jest.fn(async () => true)
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: service as never,
      hasPermission: (permission) => permission === "templates:library:write",
      confirm,
    })
    return { api, confirm }
  }

  it("saves, publishes, deprecates and deletes a draft this plugin created", async () => {
    const catalog = new TemplateCatalog()
    const draft = await userDraft()
    catalog.upsert("user", draft)
    catalog.upsert(
      "user",
      await userDraft({ id: "skill.mine", status: "published", version: "1.0.0", revision: 1 })
    )
    const service = {
      saveDraft: jest.fn(async (input) => input),
      publish: jest.fn(async () => ({ ...draft, version: "1.0.0" })),
      deprecate: jest.fn(async () => draft),
      deleteDraft: jest.fn(async () => undefined),
    }
    const { api, confirm } = apiWith(catalog, service)

    await api.saveDraft(draft, 3)
    await api.publish("skill.mine", { expectedRevision: 3, confirmedBump: "minor" })
    await api.deprecate("skill.mine", "1.0.0")
    await api.deleteDraft("skill.mine")

    expect(service.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({ pluginId: "demo.plugin" }),
      }),
      3
    )
    expect(service.publish).toHaveBeenCalledWith("skill.mine", {
      expectedRevision: 3,
      confirmedBump: "minor",
    })
    expect(service.deprecate).toHaveBeenCalledWith("skill.mine", "1.0.0", undefined)
    expect(service.deleteDraft).toHaveBeenCalledWith("skill.mine")
    // One prompt per write, each naming what it is about to do.
    expect(confirm.mock.calls.map(([request]) => request.action)).toEqual([
      "save-draft",
      "publish",
      "deprecate",
      "delete-draft",
    ])
  })

  it.each([
    ["saveDraft", async (api, draft) => api.saveDraft(draft, 3)],
    [
      "publish",
      async (api) => api.publish("skill.mine", { expectedRevision: 3, confirmedBump: "minor" }),
    ],
    ["deprecate", async (api) => api.deprecate("skill.mine", "1.0.0")],
    ["deleteDraft", async (api) => api.deleteDraft("skill.mine")],
  ])("refuses %s on a row another plugin owns", async (_name, call) => {
    const catalog = new TemplateCatalog()
    const foreign = await userDraft({
      provenance: { source: "user", trust: "unsigned", pluginId: "other.plugin" },
    })
    catalog.upsert("user", foreign)
    catalog.upsert(
      "user",
      await userDraft({
        status: "published",
        version: "1.0.0",
        revision: 1,
        provenance: { source: "user", trust: "unsigned", pluginId: "other.plugin" },
      })
    )
    const service = {
      saveDraft: jest.fn(),
      publish: jest.fn(),
      deprecate: jest.fn(),
      deleteDraft: jest.fn(),
    }
    const { api } = apiWith(catalog, service)

    await expect(call(api, foreign)).rejects.toThrow(/belongs to plugin "other.plugin"/)
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
  })

  it("refuses a row the user wrote, which carries no plugin at all", async () => {
    const catalog = new TemplateCatalog()
    catalog.upsert("user", await userDraft({ provenance: { source: "user", trust: "unsigned" } }))
    const service = { deleteDraft: jest.fn() }
    const { api } = apiWith(catalog, service)
    await expect(api.deleteDraft("skill.mine")).rejects.toThrow(/the user's own library/)
    expect(service.deleteDraft).not.toHaveBeenCalled()
  })

  it("refuses every write without templates:library:write, before prompting", async () => {
    const catalog = new TemplateCatalog()
    catalog.upsert("user", await userDraft())
    const confirm = jest.fn(async () => true)
    const service = { deleteDraft: jest.fn(), exportPackage: jest.fn(), importPackage: jest.fn() }
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: service as never,
      hasPermission: () => false,
      confirm,
    })
    await expect(api.deleteDraft("skill.mine")).rejects.toThrow(/templates:library:write/)
    await expect(api.importPackage(new Uint8Array([1]))).rejects.toThrow(/templates:library:write/)
    expect(confirm).not.toHaveBeenCalled()
  })

  it("refuses every write the user declines", async () => {
    const catalog = new TemplateCatalog()
    catalog.upsert("user", await userDraft())
    const service = { deleteDraft: jest.fn() }
    const api = createTemplatesAPI("demo.plugin", {
      catalog,
      service: service as never,
      hasPermission: () => true,
      confirm: async () => false,
    })
    await expect(api.deleteDraft("skill.mine")).rejects.toThrow(/denied by user confirmation/)
    expect(service.deleteDraft).not.toHaveBeenCalled()
  })

  it("forks somebody else's release and stamps the copy with this plugin", async () => {
    const catalog = new TemplateCatalog()
    const upstream = await userDraft({
      id: "skill.theirs",
      status: "published",
      version: "2.0.0",
      revision: 1,
      provenance: { source: "user", trust: "unsigned", pluginId: "other.plugin" },
    })
    catalog.upsert("user", upstream)
    const service = {
      fork: jest.fn(async () => ({
        ...upstream,
        id: "skill.copy",
        status: "draft",
        version: null,
        revision: 1,
        provenance: { source: "user", trust: "unsigned" },
      })),
      saveDraft: jest.fn(async (input) => input),
    }
    const { api } = apiWith(catalog, service)

    const forked = await api.fork("skill.theirs", { version: "2.0.0", newId: "skill.copy" })

    expect(service.fork).toHaveBeenCalledWith("skill.theirs", {
      version: "2.0.0",
      newId: "skill.copy",
    })
    expect(forked.provenance.pluginId).toBe("demo.plugin")
  })

  it('imports a package as source "plugin", naming itself as the importer', async () => {
    const catalog = new TemplateCatalog()
    const inspected = {
      fingerprint: "f",
      manifest: {},
      definitions: [],
      assets: new Map(),
      trust: "unsigned",
    }
    const service = { importPackage: jest.fn(async () => inspected) }
    const { api, confirm } = apiWith(catalog, service)
    const bytes = new Uint8Array([1, 2, 3])

    await expect(api.importPackage(bytes)).resolves.toBe(inspected)

    // `importedBy` is what lets the importer publish/deprecate/delete the rows
    // it just installed: without it the releases keep the AUTHOR's pluginId and
    // `assertPluginOwnsLibraryEntry` refuses the importer every write.
    expect(service.importPackage).toHaveBeenCalledWith(bytes, {
      source: "plugin",
      confirmed: true,
      importedBy: { pluginId: "demo.plugin" },
    })
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ action: "import-package", pluginId: "demo.plugin" })
    )
  })

  it("exports a package behind the same permission and prompt", async () => {
    const catalog = new TemplateCatalog()
    const exported = { bytes: new Uint8Array(), fingerprint: "f", manifest: {} }
    const service = { exportPackage: jest.fn(async () => exported) }
    const { api, confirm } = apiWith(catalog, service)
    const input = {
      id: "pkg",
      version: "1.0.0",
      name: "Pack",
      definitionIds: [{ id: "skill.mine", version: "1.0.0" }],
    }

    await expect(api.exportPackage(input)).resolves.toBe(exported)
    expect(service.exportPackage).toHaveBeenCalledWith(input)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ action: "export-package", definitionId: "pkg" })
    )
  })
})
