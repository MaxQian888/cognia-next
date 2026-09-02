import { CATALOG_SCHEMA_VERSION, type CatalogSnapshot } from "@cognia/provider-types/model-catalog"

import {
  activateCatalogRevision,
  DexieCatalogRepository,
  getActiveCatalogSnapshot,
  getCatalogState,
  getConnectionInventory,
  getOperationSnapshot,
  listOperationSnapshots,
  operationSnapshotId,
  putConnectionInventory,
  putOperationSnapshots,
  stageCatalogRevision,
} from "./provider-catalog"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

function snapshot(id: string, modelId = "openai:gpt-test"): CatalogSnapshot {
  return {
    revision: {
      id,
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: "2026-07-31T00:00:00.000Z",
      sources: [{ kind: "bundled", id }],
      checksum: `sha256:${id}`,
      integrity: "verified",
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        tier: "certified",
        source: { kind: "bundled", id },
        modalities: ["language"],
        adapterFamilies: ["openai-compatible"],
        connectionSchema: { fields: [] },
      },
    ],
    models: [
      {
        id: modelId,
        name: modelId,
        creator: "openai",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: { streaming: true },
        lifecycle: "active",
        provenance: {},
      },
    ],
    offerings: [
      {
        id: `openai:${modelId}`,
        providerRef: "openai",
        modelRef: modelId,
        upstreamId: modelId,
        endpointType: "responses",
        lifecycle: "active",
        available: true,
        source: { kind: "bundled", id },
      },
    ],
    aliases: [],
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("provider catalog revisions", () => {
  it("stages complete rows and atomically activates a verified revision", async () => {
    await stageCatalogRevision(snapshot("r1"))
    expect(await getCatalogState()).toEqual({
      id: "singleton",
      stagedRevisionIds: ["r1"],
    })

    await activateCatalogRevision("r1")

    expect((await getCatalogState())?.activeRevisionId).toBe("r1")
    expect(await getActiveCatalogSnapshot()).toEqual(snapshot("r1"))
  })

  it("retains only active and previous revisions", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      await stageCatalogRevision(snapshot(id, `openai:model-${id}`))
      await activateCatalogRevision(id)
    }

    const state = await getCatalogState()
    expect(state).toMatchObject({
      activeRevisionId: "r3",
      previousRevisionId: "r2",
      stagedRevisionIds: [],
    })
    expect(await getDb().providerCatalogRevisions.toArray()).toHaveLength(2)
    expect(await getDb().providerCatalogModels.where("revisionId").equals("r1").count()).toBe(0)
  })

  it("leaves last-known-good active when staging is invalid", async () => {
    await stageCatalogRevision(snapshot("good"))
    await activateCatalogRevision("good")
    const invalid = snapshot("bad")
    invalid.offerings[0].modelRef = "missing"

    await expect(stageCatalogRevision(invalid)).rejects.toThrow(/missing model/)

    expect((await getCatalogState())?.activeRevisionId).toBe("good")
    expect(await getActiveCatalogSnapshot()).toEqual(snapshot("good"))
  })

  it("hydrates the shared synchronous repository from the active Dexie revision", async () => {
    await stageCatalogRevision(snapshot("r1"))
    await activateCatalogRevision("r1")
    const repository = new DexieCatalogRepository()

    await repository.hydrate()

    expect(repository.resolveOffering("openai", "openai:gpt-test")?.modelRef).toBe(
      "openai:gpt-test"
    )
    expect(repository.searchModels({ query: "gpt-test" })).toHaveLength(1)
  })
})

describe("connection inventory", () => {
  it("stores deployment-local availability without mutating catalog certification", async () => {
    await putConnectionInventory({
      id: "deployment:openai-main",
      deploymentRef: "openai-main",
      providerRef: "openai",
      status: "healthy",
      checkedAt: 1_775_000_000_000,
      availableUpstreamIds: ["gpt-test"],
    })

    expect(await getConnectionInventory("openai-main")).toEqual({
      id: "deployment:openai-main",
      deploymentRef: "openai-main",
      providerRef: "openai",
      status: "healthy",
      checkedAt: 1_775_000_000_000,
      availableUpstreamIds: ["gpt-test"],
    })
  })

  it("keeps the listing, its provenance and the account it was taken under", async () => {
    await putConnectionInventory({
      id: "deployment:openai-main",
      deploymentRef: "openai-main",
      providerRef: "openai",
      status: "healthy",
      checkedAt: 10,
      availableUpstreamIds: ["gpt-test"],
      accountRef: "fnv-abc",
      models: [{ id: "gpt-test", name: "GPT Test", contextLength: 8_000 }],
      source: "remote-discovered",
      freshness: "fresh",
      expiresAt: 3_610,
    })
    expect(await getConnectionInventory("openai-main")).toMatchObject({
      accountRef: "fnv-abc",
      models: [{ id: "gpt-test", contextLength: 8_000 }],
      source: "remote-discovered",
      freshness: "fresh",
      expiresAt: 3_610,
    })
  })
})

describe("operation snapshots", () => {
  const cell = (operationId: "models.list" | "embeddings.create") => ({
    operationId,
    support: "native" as const,
    availability: "ready" as const,
  })

  it("keys a snapshot by deployment, account and operation, never by provider alone", async () => {
    expect(
      operationSnapshotId({ deploymentRef: "d", accountRef: "a", operationId: "models.list" })
    ).toBe("d#a#models.list")
    await putOperationSnapshots({
      providerId: "openai",
      deploymentRef: "openai-main",
      accountRef: "acct-1",
      cells: [cell("models.list")],
      computedAt: 5,
    })
    await putOperationSnapshots({
      providerId: "openai",
      deploymentRef: "openai-main",
      accountRef: "acct-2",
      cells: [cell("models.list"), cell("embeddings.create")],
      computedAt: 6,
    })
    expect(
      await getOperationSnapshot({
        deploymentRef: "openai-main",
        accountRef: "acct-1",
        operationId: "models.list",
      })
    ).toMatchObject({ providerId: "openai", computedAt: 5 })
    expect(
      (await listOperationSnapshots({ providerId: "openai" })).map((row) => row.id).sort()
    ).toEqual([
      "openai-main#acct-1#models.list",
      "openai-main#acct-2#embeddings.create",
      "openai-main#acct-2#models.list",
    ])
  })

  it("replaces one account's cells wholesale and leaves the other account alone", async () => {
    await putOperationSnapshots({
      providerId: "openai",
      deploymentRef: "openai-main",
      accountRef: "acct-1",
      cells: [cell("models.list"), cell("embeddings.create")],
      computedAt: 1,
    })
    await putOperationSnapshots({
      providerId: "openai",
      deploymentRef: "openai-main",
      accountRef: "acct-2",
      cells: [cell("models.list")],
      computedAt: 1,
    })
    await putOperationSnapshots({
      providerId: "openai",
      deploymentRef: "openai-main",
      accountRef: "acct-1",
      cells: [cell("models.list")],
      computedAt: 2,
    })
    const rows = await listOperationSnapshots({
      providerId: "openai",
      deploymentRef: "openai-main",
    })
    expect(rows.map((row) => row.id).sort()).toEqual([
      "openai-main#acct-1#models.list",
      "openai-main#acct-2#models.list",
    ])
    expect(
      await getOperationSnapshot({
        deploymentRef: "openai-main",
        accountRef: "acct-1",
        operationId: "models.list",
      })
    ).toMatchObject({ computedAt: 2 })
  })
})
