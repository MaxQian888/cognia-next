import { TemplateCatalog } from "./catalog"
import { migrateLegacyTemplates, rollbackTemplateMigration } from "./migration"
import { InMemoryTemplateRepository, type TemplateMigrationJournalRecord } from "./repository"
import { TemplateService, type TemplateDomainAdapter } from "./service"

const adapter: TemplateDomainAdapter = {
  domain: "skill",
  project: async (resource) => resource as never,
  validate: () => [],
  preflight: async ({ definition }) => ({
    definitionId: definition.id,
    definitionHash: definition.contentHash,
    status: "ready",
    bindings: [],
    issues: [],
    operations: [],
    requiresConfirmation: false,
  }),
  instantiate: async () => ({ resources: [] }),
  snapshot: async () => ({}),
  diff: () => ({ changes: [], conflicts: [] }),
  update: async () => ({ resources: [] }),
}

function setup() {
  const repository = new InMemoryTemplateRepository()
  const service = new TemplateService({
    repository,
    catalog: new TemplateCatalog(),
    adapters: [adapter],
    now: () => 100,
    id: () => "id",
  })
  const records = new Map<string, TemplateMigrationJournalRecord>()
  const journal = {
    list: async (domain?: string) =>
      [...records.values()].filter((record) => !domain || record.domain === domain),
    put: async (record: TemplateMigrationJournalRecord) => {
      records.set(record.id, structuredClone(record))
    },
  }
  return { repository, service, records, journal }
}

describe("template migration", () => {
  it("is idempotent and quarantines malformed rows without dropping their snapshot", async () => {
    const { repository, service, records, journal } = setup()
    const rows = [
      { id: "valid", name: "Valid", content: "hello" },
      { id: "broken", name: "", content: "bad" },
    ]
    const source = {
      domain: "skill" as const,
      read: async () => rows,
      sourceKey: (row: (typeof rows)[number]) => row.id,
      convert: (row: (typeof rows)[number]) => {
        if (!row.name) throw new Error("name is required")
        return {
          id: `legacy.skill.${row.id}`,
          domain: "skill" as const,
          metadata: { name: row.name },
          payload: { content: row.content },
          inputs: [],
          dependencies: [],
          capabilities: [],
          compatibility: { platforms: ["desktop" as const, "web" as const] },
        }
      },
    }

    const first = await migrateLegacyTemplates({
      sources: [source],
      service,
      repository,
      journal,
      now: () => 100,
    })
    const second = await migrateLegacyTemplates({
      sources: [source],
      service,
      repository,
      journal,
      now: () => 200,
    })

    expect(first).toEqual({ examined: 2, migrated: 1, skipped: 0, quarantined: 1 })
    expect(second).toEqual({ examined: 2, migrated: 0, skipped: 1, quarantined: 1 })
    expect(records.get("skill:broken")).toMatchObject({
      status: "quarantined",
      rollbackSnapshot: rows[1],
    })
  })

  it("removes migrated drafts while retaining rollback evidence", async () => {
    const { repository, service, records, journal } = setup()
    await migrateLegacyTemplates({
      sources: [
        {
          domain: "skill",
          read: async () => [{ id: "one" }],
          sourceKey: (row: { id: string }) => row.id,
          convert: () => ({
            id: "legacy.skill.one",
            domain: "skill",
            metadata: { name: "One" },
            payload: { content: "one" },
            inputs: [],
            dependencies: [],
            capabilities: [],
            compatibility: { platforms: ["desktop"] },
          }),
        },
      ],
      service,
      repository,
      journal,
    })

    expect(
      await rollbackTemplateMigration({
        domain: "skill",
        repository,
        journal,
        now: () => 300,
      })
    ).toBe(1)
    expect(await repository.getDraft("legacy.skill.one")).toBeUndefined()
    expect(records.get("skill:one")).toMatchObject({
      status: "rolled-back",
      rollbackSnapshot: { id: "one" },
    })
  })
})
