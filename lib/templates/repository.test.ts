import { createTemplateDefinition } from "./contracts"
import { InMemoryTemplateRepository, type StoredTemplatePackage } from "./repository"

async function draft(id: string, revision = 0) {
  return createTemplateDefinition({
    id,
    domain: "skill",
    status: "draft",
    revision,
    metadata: { name: id },
    payload: { content: id },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user" },
  })
}

async function release(id: string, version: string) {
  return createTemplateDefinition({
    id,
    domain: "skill",
    status: "published",
    revision: 1,
    version,
    metadata: { name: id },
    payload: { content: id },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user" },
  })
}

function pkg(key: string, fingerprint: string): StoredTemplatePackage {
  return {
    key,
    manifest: { id: key, version: "1.0.0" } as StoredTemplatePackage["manifest"],
    fingerprint,
    trust: "unsigned",
    importedAt: 1,
    source: "file",
  }
}

describe("InMemoryTemplateRepository drafts", () => {
  it("saves a first draft only against revision 0", async () => {
    const repo = new InMemoryTemplateRepository()
    const result = await repo.saveDraft(await draft("skill.one"), 0)
    expect(result.saved).toBe(true)
    expect(await repo.getDraft("skill.one")).toBeDefined()
  })

  it("refuses a save whose expected revision is stale and reports the current row", async () => {
    // Optimistic concurrency: two editors on the same draft must not silently
    // clobber each other, so the loser gets the winning row back to rebase on.
    const repo = new InMemoryTemplateRepository()
    // The stored row now sits at revision 1, so a caller still holding
    // revision 0 is editing a copy someone else has already moved on from.
    await repo.saveDraft(await draft("skill.one", 1), 0)
    const stale = await repo.saveDraft(await draft("skill.one", 2), 0)
    expect(stale.saved).toBe(false)
    if (stale.saved) throw new Error("unreachable")
    expect(stale.current?.revision).toBe(1)
  })

  it("reports no current row when the conflict is that the draft is gone", async () => {
    const repo = new InMemoryTemplateRepository()
    const result = await repo.saveDraft(await draft("skill.missing"), 7)
    expect(result.saved).toBe(false)
    if (result.saved) throw new Error("unreachable")
    expect(result.current).toBeUndefined()
  })

  it("rejects anything versioned or already published as a draft save", async () => {
    const repo = new InMemoryTemplateRepository()
    await expect(repo.saveDraft(await release("skill.one", "1.0.0"), 0)).rejects.toThrow(
      /mutable drafts/
    )
  })

  it("hands out copies so a caller cannot mutate stored state through the result", async () => {
    const repo = new InMemoryTemplateRepository()
    const definition = await draft("skill.one")
    await repo.saveDraft(definition, 0)
    definition.metadata.name = "mutated after save"

    expect((await repo.getDraft("skill.one"))?.metadata.name).toBe("skill.one")
  })

  it("drops a draft on delete", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.saveDraft(await draft("skill.one"), 0)
    await repo.deleteDraft("skill.one")
    expect(await repo.getDraft("skill.one")).toBeUndefined()
  })
})

describe("InMemoryTemplateRepository releases", () => {
  it("stores and reads a release back by id and version", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.putRelease(await release("skill.one", "1.0.0"))
    expect((await repo.getRelease("skill.one", "1.0.0"))?.version).toBe("1.0.0")
    expect(await repo.getRelease("skill.one", "9.9.9")).toBeUndefined()
  })

  it("treats a published version as immutable", async () => {
    // A version that can be rewritten is not a version: anything that already
    // resolved this id@version would silently change meaning underneath it.
    const repo = new InMemoryTemplateRepository()
    await repo.putRelease(await release("skill.one", "1.0.0"))
    await expect(repo.putRelease(await release("skill.one", "1.0.0"))).rejects.toThrow(/immutable/)
  })

  it("rejects an unversioned or still-draft definition as a release", async () => {
    const repo = new InMemoryTemplateRepository()
    await expect(repo.putRelease(await draft("skill.one"))).rejects.toThrow(/versioned releases/)
  })

  it("lists only the requested id's releases", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.putRelease(await release("skill.one", "1.0.0"))
    await repo.putRelease(await release("skill.one", "1.1.0"))
    await repo.putRelease(await release("skill.two", "1.0.0"))

    expect((await repo.listReleases("skill.one")).map((d) => d.version)).toEqual(["1.0.0", "1.1.0"])
  })

  it("returns drafts and releases together from listDefinitions", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.saveDraft(await draft("skill.draft"), 0)
    await repo.putRelease(await release("skill.released", "1.0.0"))

    expect((await repo.listDefinitions()).map((d) => d.id).sort()).toEqual([
      "skill.draft",
      "skill.released",
    ])
  })

  it("moves a release to deprecated or yanked without losing its identity", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.putRelease(await release("skill.one", "1.0.0"))
    const next = await repo.setReleaseStatus("skill.one", "1.0.0", "yanked", 42)

    expect(next.status).toBe("yanked")
    expect(next.updatedAt).toBe(42)
    expect((await repo.getRelease("skill.one", "1.0.0"))?.status).toBe("yanked")
  })

  it("throws when asked to re-status a release that is not there", async () => {
    const repo = new InMemoryTemplateRepository()
    await expect(repo.setReleaseStatus("skill.ghost", "1.0.0", "yanked", 1)).rejects.toThrow(
      /not found/
    )
  })
})

describe("InMemoryTemplateRepository packages", () => {
  it("accepts a re-put of the same fingerprint and rejects a changed one", async () => {
    // Same key + same fingerprint is a harmless re-import; same key with
    // different bytes means two different packages are claiming one identity.
    const repo = new InMemoryTemplateRepository()
    await repo.putPackage(pkg("pack.one", "fp-1"))
    await expect(repo.putPackage(pkg("pack.one", "fp-1"))).resolves.toBeUndefined()
    await expect(repo.putPackage(pkg("pack.one", "fp-2"))).rejects.toThrow(/immutable/)
  })

  it("imports a package and its releases in one step", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.importPackage(pkg("pack.one", "fp-1"), [await release("skill.one", "1.0.0")])

    expect((await repo.listPackages()).map((p) => p.key)).toEqual(["pack.one"])
    expect(await repo.getRelease("skill.one", "1.0.0")).toBeDefined()
  })

  it("refuses an import that would rewrite an existing release's content", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.putRelease(await release("skill.one", "1.0.0"))
    const conflicting = await release("skill.one", "1.0.0")
    conflicting.contentHash = "different-hash"

    await expect(repo.importPackage(pkg("pack.one", "fp-1"), [conflicting])).rejects.toThrow(
      /immutable/
    )
  })

  it("leaves the package unstored when its releases conflict", async () => {
    // The conflict check runs over every definition before anything is written,
    // so a rejected import must not leave the package half-registered.
    const repo = new InMemoryTemplateRepository()
    await repo.putRelease(await release("skill.one", "1.0.0"))
    const conflicting = await release("skill.one", "1.0.0")
    conflicting.contentHash = "different-hash"

    await expect(repo.importPackage(pkg("pack.one", "fp-1"), [conflicting])).rejects.toThrow()
    expect(await repo.listPackages()).toEqual([])
  })

  it("refuses an import under a key already held at another fingerprint", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.putPackage(pkg("pack.one", "fp-1"))
    await expect(repo.importPackage(pkg("pack.one", "fp-2"), [])).rejects.toThrow(/immutable/)
  })

  it("reconciles package and imported release trust without changing content", async () => {
    const repo = new InMemoryTemplateRepository()
    const definition = await release("skill.one", "1.0.0")
    const storedPackage = {
      ...pkg("pack.one", "fp-1"),
      manifest: {
        id: "pack.one",
        version: "1.0.0",
        definitions: [{ id: "skill.one", version: "1.0.0" }],
      } as StoredTemplatePackage["manifest"],
    }
    await repo.importPackage(storedPackage, [definition])

    await repo.reconcilePackageTrust("pack.one", "signed-unknown")

    expect((await repo.listPackages())[0].trust).toBe("signed-unknown")
    expect((await repo.getRelease("skill.one", "1.0.0"))?.provenance.trust).toBe("signed-unknown")
    expect((await repo.getRelease("skill.one", "1.0.0"))?.contentHash).toBe(definition.contentHash)
  })

  it("skips missing manifest definitions and rejects a missing package during reconciliation", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.putPackage({
      ...pkg("pack.one", "fp-1"),
      manifest: {
        id: "pack.one",
        version: "1.0.0",
        definitions: [{ id: "skill.missing", version: "1.0.0" }],
      } as StoredTemplatePackage["manifest"],
    })

    await expect(repo.reconcilePackageTrust("pack.one", "signed-unknown")).resolves.toBeUndefined()
    await expect(repo.reconcilePackageTrust("pack.missing", "signed-unknown")).rejects.toThrow(
      /not found/
    )
  })
})

describe("InMemoryTemplateRepository instances", () => {
  const instance = (id: string) => ({
    id,
    idempotencyKey: `key-${id}`,
    source: {
      definitionId: "skill.one",
      version: "1.0.0",
      revision: 1,
      status: "published" as const,
      contentHash: "hash",
      snapshot: {} as never,
    },
    bindingFingerprint: "fp",
    resources: [],
    baseline: null,
    createdAt: 1,
    updatedAt: 1,
  })

  it("round-trips an instance and lists it", async () => {
    const repo = new InMemoryTemplateRepository()
    await repo.putInstance(instance("inst-1"))

    expect((await repo.getInstance("inst-1"))?.idempotencyKey).toBe("key-inst-1")
    expect((await repo.listInstances()).map((i) => i.id)).toEqual(["inst-1"])
    expect(await repo.getInstance("inst-missing")).toBeUndefined()
  })

  it("copies on write so later mutation of the argument cannot reach the store", async () => {
    const repo = new InMemoryTemplateRepository()
    const value = instance("inst-1")
    await repo.putInstance(value)
    value.bindingFingerprint = "mutated"

    expect((await repo.getInstance("inst-1"))?.bindingFingerprint).toBe("fp")
  })
})
