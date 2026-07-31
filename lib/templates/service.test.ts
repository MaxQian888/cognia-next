import { TemplateCatalog } from "./catalog"
import { InMemoryTemplateRepository } from "./repository"
import { TemplateService, type TemplateDomainAdapter } from "./service"

const skillAdapter: TemplateDomainAdapter = {
  domain: "skill",
  project: async (resource) => resource as never,
  validate: () => [],
  preflight: async ({ definition }) => ({
    definitionId: definition.id,
    definitionHash: definition.contentHash,
    status: "ready",
    bindings: [],
    issues: [],
    operations: [{ id: "create", kind: "create", domain: "skill", summary: "Create skill" }],
    requiresConfirmation: false,
  }),
  instantiate: async ({ definition }) => ({
    resources: [{ domain: "skill", id: `created:${definition.id}` }],
    rollbackToken: null,
  }),
  snapshot: async () => ({ content: "snapshot" }),
  diff: () => ({ changes: [], conflicts: [] }),
  update: async () => ({ resources: [] }),
}

function makeService() {
  const repository = new InMemoryTemplateRepository()
  const catalog = new TemplateCatalog()
  const service = new TemplateService({
    repository,
    catalog,
    adapters: [skillAdapter],
    now: () => 1_000,
    id: () => "generated",
  })
  return { repository, catalog, service }
}

describe("TemplateService lifecycle", () => {
  it("keeps both edits when an optimistic draft save conflicts", async () => {
    const { repository, catalog, service } = makeService()
    const original = await service.createDraft({
      id: "skill.summary",
      domain: "skill",
      metadata: { name: "Summary" },
      payload: { content: "v1" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
    })
    await service.saveDraft({ ...original, payload: { content: "remote" } }, original.revision)
    const conflict = await service.saveDraft(
      { ...original, payload: { content: "local" } },
      original.revision
    )

    expect(conflict.status).toBe("conflict")
    expect(conflict.id).toBe("skill.summary.conflict.generated")
    expect((await repository.getDraft("skill.summary"))?.payload).toEqual({ content: "remote" })
    expect((await repository.getDraft(conflict.id))?.payload).toEqual({ content: "local" })
    expect(catalog.query({ status: "conflict" })).toHaveLength(1)
  })

  it("publishes an immutable version and rejects overwrite", async () => {
    const { repository, service } = makeService()
    await service.createDraft({
      id: "skill.summary",
      domain: "skill",
      metadata: { name: "Summary" },
      payload: { content: "v1" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
    })
    const published = await service.publish("skill.summary", {
      expectedRevision: 1,
      confirmedBump: "minor",
    })

    expect(published.status).toBe("published")
    expect(published.version).toBe("0.1.0")
    await expect(
      repository.putRelease({ ...published, metadata: { name: "Overwrite" } })
    ).rejects.toThrow(/immutable/i)
  })

  it("preflights before instantiation and records immutable provenance", async () => {
    const { repository, service } = makeService()
    const draft = await service.createDraft({
      id: "skill.summary",
      domain: "skill",
      metadata: { name: "Summary" },
      payload: { content: "v1" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
    })
    const plan = await service.preflight({
      definitionId: draft.id,
      platform: "desktop",
      bindings: {},
    })
    const result = await service.instantiate({ plan, confirmed: true })
    const repeated = await service.instantiate({ plan, confirmed: true })

    expect(result.resources).toEqual([{ domain: "skill", id: "created:skill.summary" }])
    expect(repeated.resources).toEqual(result.resources)
    expect(await repository.listInstances()).toHaveLength(1)
    const instance = (await repository.listInstances())[0]
    expect(instance.source.contentHash).toBe(draft.contentHash)
    expect(instance.source.status).toBe("draft")
    expect(instance.resources).toEqual(result.resources)
  })

  it("blocks templates outside the host SemVer compatibility range", async () => {
    const repository = new InMemoryTemplateRepository()
    const catalog = new TemplateCatalog()
    const service = new TemplateService({
      repository,
      catalog,
      adapters: [skillAdapter],
      hostVersion: "1.4.0",
    })
    const draft = await service.createDraft({
      id: "skill.future",
      domain: "skill",
      metadata: { name: "Future skill" },
      payload: { content: "future" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"], minHostVersion: "2.0.0" },
    })

    const plan = await service.preflight({
      definitionId: draft.id,
      platform: "desktop",
      bindings: {},
    })

    expect(plan.status).toBe("blocked")
    expect(plan.issues).toEqual([
      expect.objectContaining({ code: "host-version.unsupported", severity: "blocker" }),
    ])
  })

  it("exposes migration rollback through the service boundary", async () => {
    const rollbackMigration = jest.fn(async () => 3)
    const service = new TemplateService({
      repository: new InMemoryTemplateRepository(),
      catalog: new TemplateCatalog(),
      adapters: [skillAdapter],
      rollbackMigration,
    })

    await expect(service.rollbackMigration("skill")).resolves.toBe(3)
    expect(rollbackMigration).toHaveBeenCalledWith("skill")
  })

  it("deprecates releases without mutating their immutable content", async () => {
    const { repository, service } = makeService()
    await service.createDraft({
      id: "skill.summary",
      domain: "skill",
      metadata: { name: "Summary" },
      payload: { content: "v1" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
    })
    const published = await service.publish("skill.summary", {
      expectedRevision: 1,
      confirmedBump: "minor",
    })

    const deprecated = await service.deprecate("skill.summary", published.version!)

    expect(deprecated.status).toBe("deprecated")
    expect(deprecated.contentHash).toBe(published.contentHash)
    expect((await repository.getRelease("skill.summary", published.version!))?.status).toBe(
      "deprecated"
    )
  })

  it("blocks missing required dependencies and applies optional omit fallback", async () => {
    const { service } = makeService()
    await service.createDraft({
      id: "skill.dependencies",
      domain: "skill",
      metadata: { name: "Dependencies" },
      payload: { content: "x" },
      inputs: [],
      dependencies: [
        {
          id: "plugin.required",
          kind: "plugin",
          requirement: "required",
        },
        {
          id: "plugin.optional",
          kind: "plugin",
          requirement: "optional",
          fallback: "omit",
        },
      ],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
    })

    const plan = await service.preflight({
      definitionId: "skill.dependencies",
      platform: "desktop",
      bindings: {},
    })

    expect(plan.status).toBe("blocked")
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dependency.required-missing",
          severity: "blocker",
        }),
        expect.objectContaining({
          code: "dependency.optional-fallback",
          severity: "warning",
        }),
      ])
    )
  })

  it("plans a three-way update, blocks conflicts, and preserves detached instances", async () => {
    const repository = new InMemoryTemplateRepository()
    const catalog = new TemplateCatalog()
    const adapter: TemplateDomainAdapter = {
      ...skillAdapter,
      snapshot: async () => ({ content: "local edit" }),
      diff: () => ({
        changes: [],
        conflicts: [
          {
            path: "$.content",
            baseline: "v1",
            local: "local edit",
            next: "v2",
          },
        ],
      }),
    }
    const service = new TemplateService({
      repository,
      catalog,
      adapters: [adapter],
      now: () => 1_000,
      id: () => "generated",
    })
    const draft = await service.createDraft({
      id: "skill.summary",
      domain: "skill",
      metadata: { name: "Summary" },
      payload: { content: "v1" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
    })
    const first = await service.publish(draft.id, {
      expectedRevision: 1,
      confirmedBump: "minor",
    })
    const plan = await service.preflight({
      definitionId: first.id,
      version: first.version!,
      platform: "desktop",
      bindings: {},
    })
    await service.instantiate({ plan, confirmed: true })
    const instance = (await repository.listInstances())[0]
    const edited = await service.saveDraft({ ...draft, payload: { content: "v2" } }, draft.revision)
    const second = await service.publish(edited.id, {
      expectedRevision: edited.revision,
      confirmedBump: "patch",
    })

    const update = await service.planUpdate(instance.id, second.version!)

    expect(update.status).toBe("blocked")
    expect(update.diff.conflicts).toHaveLength(1)
    await expect(service.applyUpdate(update, { confirmed: true })).rejects.toThrow(/blocked/i)

    const detached = await service.detachInstance(instance.id)
    expect(detached.detachedAt).toBe(1_000)
    await expect(service.planUpdate(instance.id, second.version!)).rejects.toThrow(/detached/i)
  })
})
