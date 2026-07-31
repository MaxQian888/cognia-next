/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  listMarketplaceSources,
  addMarketplaceSource,
  removeMarketplaceSource,
  recordSourceSync,
} from "@/lib/db/plugin-marketplace-sources"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().pluginMarketplaceSources.clear()
})

test("add + list (newest first) + remove round-trips", async () => {
  await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "A" })
  await addMarketplaceSource({ id: "acme/b", repoRef: "acme/b", name: "B" })

  const list = await listMarketplaceSources()
  expect(list.map((s) => s.id)).toEqual(["acme/b", "acme/a"]) // newest first

  await removeMarketplaceSource("acme/a")
  const after = await listMarketplaceSources()
  expect(after.map((s) => s.id)).toEqual(["acme/b"])
})

test("re-adding the same id updates name but keeps addedAt", async () => {
  const first = await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "Old" })
  const second = await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a@v2", name: "New" })
  expect(second.addedAt).toBe(first.addedAt)
  expect(second.name).toBe("New")
  expect(await listMarketplaceSources()).toHaveLength(1)
})

test("adding with a fresh sync seeds health and clears a stale error", async () => {
  await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "A" })
  await recordSourceSync("acme/a", { ok: false, message: "boom" })

  const row = await addMarketplaceSource({
    id: "acme/a",
    repoRef: "acme/a",
    name: "A",
    pluginCount: 3,
    lastSyncedAt: 1_700_000_000_000,
  })
  expect(row.pluginCount).toBe(3)
  expect(row.lastSyncedAt).toBe(1_700_000_000_000)
  expect(row.lastError).toBeUndefined()
})

test("re-adding without health keeps what the last sync recorded", async () => {
  await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "A" })
  await recordSourceSync("acme/a", { ok: true, pluginCount: 5 })

  const row = await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "A" })
  expect(row.pluginCount).toBe(5)
  expect(row.lastSyncedAt).toEqual(expect.any(Number))
})

test("recordSourceSync stores a failure, then a success clears it", async () => {
  await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "A" })

  await recordSourceSync("acme/a", { ok: false, message: "GitHub API 403" })
  const failed = (await listMarketplaceSources())[0]
  expect(failed.lastError).toBe("GitHub API 403")
  expect(failed.lastSyncedAt).toBeUndefined()

  await recordSourceSync("acme/a", { ok: true, pluginCount: 2, name: "Renamed" })
  const healthy = (await listMarketplaceSources())[0]
  expect(healthy.lastError).toBeUndefined()
  expect(healthy.pluginCount).toBe(2)
  // The catalog is authoritative for the display name.
  expect(healthy.name).toBe("Renamed")
})

test("recordSourceSync keeps the existing name when the catalog has none", async () => {
  await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "A" })
  await recordSourceSync("acme/a", { ok: true, pluginCount: 1, name: "   " })
  expect((await listMarketplaceSources())[0].name).toBe("A")
})

test("recordSourceSync does not resurrect a source removed mid-refresh", async () => {
  await addMarketplaceSource({ id: "acme/a", repoRef: "acme/a", name: "A" })
  await removeMarketplaceSource("acme/a")
  await recordSourceSync("acme/a", { ok: true, pluginCount: 9 })
  expect(await listMarketplaceSources()).toHaveLength(0)
})
