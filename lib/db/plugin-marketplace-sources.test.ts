/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  listMarketplaceSources,
  addMarketplaceSource,
  removeMarketplaceSource,
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
