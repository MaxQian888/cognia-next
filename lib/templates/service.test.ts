import JSZip from "jszip"
import { generateKeyPairSync, sign } from "node:crypto"

import { TemplateCatalog } from "./catalog"
import { createTemplateDefinition, TEMPLATE_API_VERSION } from "./contracts"
import {
  exportTemplatePackage,
  templatePackageSignaturePayload,
  type TemplatePackageManifest,
} from "./package"
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

function makeService(options?: { isPublisherTrusted?: (publicKey: string) => Promise<boolean> }) {
  const repository = new InMemoryTemplateRepository()
  const catalog = new TemplateCatalog()
  const service = new TemplateService({
    repository,
    catalog,
    adapters: [skillAdapter],
    now: () => 1_000,
    id: () => "generated",
    isPublisherTrusted: options?.isPublisherTrusted,
  })
  return { repository, catalog, service }
}

async function createSignedPackage(): Promise<{ bytes: Uint8Array; publicKey: string }> {
  const definition = await createTemplateDefinition({
    id: "skill.marketplace",
    domain: "skill",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Marketplace skill" },
    payload: { content: "signed" },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
  const packaged = await exportTemplatePackage({
    id: "com.example.marketplace",
    version: "1.0.0",
    name: "Marketplace package",
    entrypoints: [definition.id],
    definitions: [definition],
  })
  const zip = await JSZip.loadAsync(packaged.bytes)
  const manifest = JSON.parse(
    await zip.file("manifest.json")!.async("string")
  ) as TemplatePackageManifest
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const encodedPublicKey = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64")
  manifest.signature = {
    algorithm: "ed25519",
    publisher: "example",
    publicKey: encodedPublicKey,
    signature: sign(null, templatePackageSignaturePayload(manifest), privateKey).toString("base64"),
  }
  zip.file("manifest.json", JSON.stringify(manifest))
  return { bytes: await zip.generateAsync({ type: "uint8array" }), publicKey: encodedPublicKey }
}

describe("TemplateService lifecycle", () => {
  it("does not elevate a signed marketplace package without a trusted publisher key", async () => {
    const { bytes } = await createSignedPackage()
    const { repository, service } = makeService()

    await service.importPackage(bytes, { source: "marketplace", confirmed: true })

    expect((await repository.listPackages())[0].trust).toBe("signed-unknown")
    expect((await repository.getRelease("skill.marketplace", "1.0.0"))?.provenance.trust).toBe(
      "signed-unknown"
    )
  })

  it("uses the publisher ledger for verification and downgrades revoked keys without deletion", async () => {
    const { bytes, publicKey } = await createSignedPackage()
    let trusted = true
    const { repository, service } = makeService({
      isPublisherTrusted: async (candidate) => trusted && candidate === publicKey,
    })

    await service.importPackage(bytes, { source: "marketplace", confirmed: true })
    expect((await repository.listPackages())[0].trust).toBe("verified-publisher")

    trusted = false
    await service.hydrateCatalog()

    expect((await repository.listPackages())[0].trust).toBe("signed-unknown")
    expect((await repository.getRelease("skill.marketplace", "1.0.0"))?.provenance.trust).toBe(
      "signed-unknown"
    )
    expect(await repository.listDefinitions()).toHaveLength(1)
  })

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

  it("plans a three-way update, resolves conflicts, and preserves detached instances", async () => {
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

    // A conflict is answerable, not fatal: the plan proceeds, but every
    // conflicting path has to be resolved before the write is allowed.
    expect(update.status).toBe("needs-confirmation")
    expect(update.diff.conflicts).toHaveLength(1)
    const conflictPath = update.diff.conflicts[0]!.path
    await expect(service.applyUpdate(update, { confirmed: true })).rejects.toThrow(
      /unresolved conflicts/i
    )
    await expect(
      service.applyUpdate(update, {
        confirmed: true,
        resolutions: { [conflictPath]: "upstream" },
      })
    ).resolves.toBeDefined()

    const detached = await service.detachInstance(instance.id)
    expect(detached.detachedAt).toBe(1_000)
    await expect(service.planUpdate(instance.id, second.version!)).rejects.toThrow(/detached/i)
  })
})

describe("TemplateService package maintenance", () => {
  async function importedPackage(trusted = false) {
    const { bytes, publicKey } = await createSignedPackage()
    const { repository, catalog, service } = makeService({
      isPublisherTrusted: async (key) => trusted && key === publicKey,
    })
    const inspected = await service.importPackage(bytes, { source: "file", confirmed: true })
    return {
      repository,
      catalog,
      service,
      key: `${inspected.manifest.id}@${inspected.manifest.version}`,
    }
  }

  it("re-resolves publisher trust and confirms each release still hashes to its claim", async () => {
    const { service } = await importedPackage(true)

    const report = await service.verifyPackage("com.example.marketplace@1.0.0")

    expect(report.signed).toBe(true)
    expect(report.trust).toBe("verified-publisher")
    expect(report.definitions).toEqual([
      { id: "skill.marketplace", version: "1.0.0", state: "verified" },
    ])
  })

  it("reports a release the repository no longer holds rather than claiming it is fine", async () => {
    const { repository, service, key } = await importedPackage()
    await repository.removePackage(key)
    // The package row is gone with it, so re-import the manifest half only:
    // what matters is that a manifest identity with no release reads "missing".
    await repository.putPackage({
      key,
      manifest: {
        schemaVersion: 1,
        apiVersion: TEMPLATE_API_VERSION,
        id: "com.example.marketplace",
        version: "1.0.0",
        name: "Marketplace package",
        entrypoints: ["skill.marketplace"],
        definitions: [
          {
            path: "definitions/skill.marketplace.json",
            sha256: "0".repeat(64),
            id: "skill.marketplace",
            version: "1.0.0",
          },
        ],
        assets: [],
      },
      fingerprint: "fingerprint",
      trust: "unsigned",
      importedAt: 1,
      source: "file",
    })

    const report = await service.verifyPackage(key)

    expect(report.definitions).toEqual([
      { id: "skill.marketplace", version: "1.0.0", state: "missing" },
    ])
  })

  it("marks a package yanked and takes the mark off again", async () => {
    const { repository, service, key } = await importedPackage()

    // `yankedAt` has been on the record type since the table existed and
    // nothing ever wrote it.
    expect((await service.yankPackage(key, true)).yankedAt).toBe(1_000)
    expect((await repository.listPackages())[0].yankedAt).toBe(1_000)

    expect((await service.yankPackage(key, false)).yankedAt).toBeUndefined()
    expect((await repository.listPackages())[0].yankedAt).toBeUndefined()
  })

  it("removes a package and leaves its instances rebindable rather than mysterious", async () => {
    const { repository, service, key } = await importedPackage()
    const plan = await service.preflight({
      definitionId: "skill.marketplace",
      version: "1.0.0",
      platform: "desktop",
      bindings: {},
    })
    await service.instantiate({ plan, confirmed: true })

    const removed = await service.removePackage(key)

    expect(removed).toEqual({ definitions: 1, instances: 1 })
    expect(await repository.listPackages()).toEqual([])
    expect(await repository.getRelease("skill.marketplace", "1.0.0")).toBeUndefined()
    // Not destroyed, just orphaned, so the instance card can offer to rebind.
    expect((await repository.listInstances())[0].sourceUnavailableAt).toBe(1_000)
  })

  it("rebuilds the package bytes without the signature it can no longer produce", async () => {
    const { service, key } = await importedPackage()

    const reexported = await service.reexportPackage(key)

    expect(reexported.manifest.id).toBe("com.example.marketplace")
    expect(reexported.manifest.definitions).toHaveLength(1)
    // The private key never entered this app, so a re-export is always
    // unsigned even though the original arrived signed.
    expect(reexported.manifest.signature).toBeUndefined()
  })

  it("carries the description and compatibility the manifest format allows", async () => {
    const { service } = makeService()
    await service.createDraft({
      id: "user.skill.exported",
      domain: "skill",
      metadata: { name: "Exported" },
      payload: { content: "x" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
    })
    const released = await service.publish("user.skill.exported", {
      expectedRevision: 1,
      confirmedBump: "minor",
    })

    const exported = await service.exportPackage({
      id: "com.example.bundle",
      version: "1.0.0",
      name: "Bundle",
      description: "Two of ours",
      compatibility: { platforms: ["desktop"], minHostVersion: "2.0.0" },
      definitionIds: [{ id: released.id, version: released.version! }],
    })

    expect(exported.manifest.description).toBe("Two of ours")
    expect(exported.manifest.compatibility).toEqual({
      platforms: ["desktop"],
      minHostVersion: "2.0.0",
    })
  })

  it("refuses an export with nothing in it", async () => {
    const { service } = makeService()
    await expect(
      service.exportPackage({ id: "a", version: "1.0.0", name: "A", definitionIds: [] })
    ).rejects.toThrow(/at least one release/)
  })

  it("deletes a draft and leaves published releases alone", async () => {
    const { repository, service } = makeService()
    await service.createDraft({
      id: "user.skill.scratch",
      domain: "skill",
      metadata: { name: "Scratch" },
      payload: { content: "x" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
    })

    await service.deleteDraft("user.skill.scratch")

    expect(await repository.getDraft("user.skill.scratch")).toBeUndefined()
    await expect(service.deleteDraft("user.skill.scratch")).rejects.toThrow(/not found/)
  })
})

describe("TemplateService derivation", () => {
  async function upstream(payload: Record<string, unknown> = { content: "v1", tone: "plain" }) {
    const { repository, service, catalog } = makeService()
    const draft = await service.createDraft({
      id: "skill.origin",
      domain: "skill",
      metadata: { name: "Origin" },
      payload: payload as never,
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
    })
    const release = await service.publish(draft.id, {
      expectedRevision: 1,
      confirmedBump: "minor",
    })
    return { repository, service, catalog, draft, release }
  }

  it("records where a fork came from, which a copy never did", async () => {
    const { service, release } = await upstream()
    const fork = await service.fork(release.id, { version: release.version!, newId: "skill.mine" })

    const derivation = await service.getDerivation(fork.id)
    expect(derivation).toMatchObject({
      definitionId: release.id,
      version: release.version,
      contentHash: release.contentHash,
    })
  })

  /**
   * Lineage is local, never portable. Carrying it in the envelope would put a
   * forgeable origin claim (provenance is outside `contentHash`) into every
   * export, and turn one machine's history into another's publisher metadata.
   */
  it("keeps the lineage out of the definition the catalog and exports see", async () => {
    const { service, repository, release } = await upstream()
    const fork = await service.fork(release.id, { version: release.version!, newId: "skill.mine" })

    const stored = await repository.getDraft(fork.id)
    expect(stored).toBeDefined()
    expect(stored).not.toHaveProperty("derivedFrom")
    expect(stored).not.toHaveProperty("workspaceId")
  })

  it("offers a newer upstream release and ignores anything at or below the fork", async () => {
    const { service, draft, release } = await upstream()
    const fork = await service.fork(release.id, { version: release.version!, newId: "skill.mine" })
    expect(await service.findUpstreamUpdate(fork.id)).toBeUndefined()

    const edited = await service.saveDraft(
      { ...draft, payload: { content: "v2", tone: "plain" } },
      draft.revision
    )
    const second = await service.publish(edited.id, {
      expectedRevision: edited.revision,
      confirmedBump: "patch",
    })
    expect((await service.findUpstreamUpdate(fork.id))?.version).toBe(second.version)
  })

  it("does not offer a yanked release, which the update path would refuse anyway", async () => {
    const { service, draft, release } = await upstream()
    const fork = await service.fork(release.id, { version: release.version!, newId: "skill.mine" })
    const edited = await service.saveDraft(
      { ...draft, payload: { content: "v2", tone: "plain" } },
      draft.revision
    )
    const second = await service.publish(edited.id, {
      expectedRevision: edited.revision,
      confirmedBump: "patch",
    })
    await service.deprecate(second.id, second.version!, "yanked")
    expect(await service.findUpstreamUpdate(fork.id)).toBeUndefined()
  })

  it("keeps the local edit and takes the disjoint upstream one", async () => {
    const { service, draft, release } = await upstream()
    const fork = await service.fork(release.id, { version: release.version!, newId: "skill.mine" })
    await service.saveDraft({ ...fork, payload: { content: "v1", tone: "mine" } }, fork.revision)
    const edited = await service.saveDraft(
      { ...draft, payload: { content: "v2", tone: "plain" } },
      draft.revision
    )
    const second = await service.publish(edited.id, {
      expectedRevision: edited.revision,
      confirmedBump: "patch",
    })

    const plan = await service.planDerivedUpdate(fork.id)
    expect(plan.diff.conflicts).toEqual([])
    const merged = await service.applyDerivedUpdate(plan, { confirmed: true })
    expect(merged.payload).toEqual({ content: "v2", tone: "mine" })
    // Lineage advances to what was taken, so the next check is against it.
    expect((await service.getDerivation(fork.id))?.version).toBe(second.version)
  })

  it("refuses a conflicting merge until each clashing path is answered", async () => {
    const { service, draft, release } = await upstream()
    const fork = await service.fork(release.id, { version: release.version!, newId: "skill.mine" })
    await service.saveDraft({ ...fork, payload: { content: "mine", tone: "plain" } }, fork.revision)
    const edited = await service.saveDraft(
      { ...draft, payload: { content: "theirs", tone: "plain" } },
      draft.revision
    )
    await service.publish(edited.id, { expectedRevision: edited.revision, confirmedBump: "patch" })

    const plan = await service.planDerivedUpdate(fork.id)
    expect(plan.diff.conflicts.map((c) => c.path)).toEqual(["$/content"])
    await expect(service.applyDerivedUpdate(plan, { confirmed: true })).rejects.toThrow(
      /unresolved conflicts/i
    )
    const merged = await service.applyDerivedUpdate(plan, {
      confirmed: true,
      resolutions: { "$/content": "local" },
    })
    expect(merged.payload).toEqual({ content: "mine", tone: "plain" })
  })

  /**
   * `fork()` may derive from a DRAFT, which is mutable. Re-reading the origin
   * at merge time would use the overwritten draft as the common ancestor and
   * report every field as agreed, silently taking upstream wholesale. The
   * snapshot taken at fork time is what makes the three-way merge honest.
   */
  it("merges against the snapshot taken at fork time, not the overwritten origin", async () => {
    const { service } = makeService()
    const origin = await service.createDraft({
      id: "skill.origin",
      domain: "skill",
      metadata: { name: "Origin" },
      payload: { content: "v1", tone: "plain" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
    })
    const fork = await service.fork(origin.id, { newId: "skill.mine" })
    await service.saveDraft({ ...fork, payload: { content: "v1", tone: "mine" } }, fork.revision)

    // The origin draft moves on and is then published.
    const moved = await service.saveDraft(
      { ...origin, payload: { content: "v2", tone: "plain" } },
      origin.revision
    )
    const released = await service.publish(moved.id, {
      expectedRevision: moved.revision,
      confirmedBump: "minor",
    })

    const plan = await service.planDerivedUpdate(fork.id, released.version!)
    expect(plan.diff.conflicts).toEqual([])
    const merged = await service.applyDerivedUpdate(plan, { confirmed: true })
    expect(merged.payload).toEqual({ content: "v2", tone: "mine" })
  })

  it("stops offering upstream once the fork is detached", async () => {
    const { service, release } = await upstream()
    const fork = await service.fork(release.id, { version: release.version!, newId: "skill.mine" })
    await service.detachDerivation(fork.id)
    expect(await service.getDerivation(fork.id)).toBeUndefined()
    await expect(service.planDerivedUpdate(fork.id)).rejects.toThrow(/not derived/i)
  })

  it("confines a fork to one workspace and shares it again", async () => {
    const { service, repository, release } = await upstream()
    const fork = await service.fork(release.id, {
      version: release.version!,
      newId: "skill.mine",
      workspaceId: "ws_1",
    })
    expect((await repository.getLocal(fork.id))?.workspaceId).toBe("ws_1")
    await service.setDefinitionWorkspace(fork.id, null)
    expect((await repository.getLocal(fork.id))?.workspaceId).toBeUndefined()
  })
})
