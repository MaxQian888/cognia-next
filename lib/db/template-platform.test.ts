import { createTemplateDefinition } from "@/lib/templates/contracts"
import { DexieTemplateRepository } from "./template-platform"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

async function makeDraft(id = "skill.summary") {
  return createTemplateDefinition({
    id,
    domain: "skill",
    status: "draft",
    revision: 1,
    metadata: { name: "Summary" },
    payload: { content: "Summarize {{topic}}" },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user" },
  })
}

describe("DexieTemplateRepository", () => {
  it("persists optimistic drafts in the account database", async () => {
    const repository = new DexieTemplateRepository()
    const first = await makeDraft()
    expect(await repository.saveDraft(first, 0)).toMatchObject({ saved: true })
    expect(await repository.saveDraft({ ...first, revision: 2 }, 0)).toMatchObject({
      saved: false,
      current: expect.objectContaining({ revision: 1 }),
    })
    expect(await repository.getDraft(first.id)).toMatchObject({
      id: first.id,
      revision: 1,
    })
  })

  it("keeps release rows immutable", async () => {
    const repository = new DexieTemplateRepository()
    const draft = await makeDraft()
    const release = await createTemplateDefinition({
      ...draft,
      status: "published",
      version: "1.0.0",
      revision: 1,
      contentHash: undefined,
    })
    await repository.putRelease(release)
    await expect(repository.putRelease(release)).rejects.toThrow(/immutable/i)
    expect(await repository.getRelease(release.id, "1.0.0")).toMatchObject({
      status: "published",
      version: "1.0.0",
    })
  })

  it("atomically reconciles package and release publisher trust", async () => {
    const repository = new DexieTemplateRepository()
    const draft = await makeDraft("skill.marketplace")
    const release = await createTemplateDefinition({
      ...draft,
      status: "published",
      version: "1.0.0",
      revision: 1,
      provenance: {
        source: "marketplace",
        packageId: "com.example.marketplace",
        trust: "verified-publisher",
      },
      contentHash: undefined,
    })
    await repository.importPackage(
      {
        key: "com.example.marketplace@1.0.0",
        manifest: {
          schemaVersion: 1,
          apiVersion: "cognia.ai/templates/v1",
          id: "com.example.marketplace",
          version: "1.0.0",
          name: "Marketplace",
          entrypoints: ["skill.marketplace@1.0.0"],
          definitions: [
            {
              id: release.id,
              version: release.version!,
              path: "definitions/skill.marketplace@1.0.0.json",
              sha256: release.contentHash,
            },
          ],
          assets: [],
        },
        fingerprint: "package-fingerprint",
        trust: "verified-publisher",
        importedAt: 1,
        source: "marketplace",
      },
      [release]
    )

    await repository.reconcilePackageTrust("com.example.marketplace@1.0.0", "signed-unknown")

    expect((await repository.listPackages())[0].trust).toBe("signed-unknown")
    expect((await repository.getRelease(release.id, release.version!))?.provenance.trust).toBe(
      "signed-unknown"
    )
  })

  it("opens all five template platform stores with their query indexes", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(132)
    expect(db.templateDefinitions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["id", "domain", "status", "updatedAt", "[id+status]"])
    )
    expect(db.templatePackages.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["id", "version", "trust", "importedAt"])
    )
    expect(db.templateInstances.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["source.definitionId", "updatedAt"])
    )
    expect(db.templateDeviceBindings.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["definitionId", "[definitionId+slotId]", "updatedAt"])
    )
    expect(db.templateMigrationJournal.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["domain", "status", "updatedAt"])
    )
  })
})
