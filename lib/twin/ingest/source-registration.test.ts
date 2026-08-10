/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { updateTwinSource } from "@/lib/db/twin-sources"
import { registerTwinSource } from "./source-registration"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().twinSources.clear()
})

const draft = {
  twinId: "twin-a",
  kind: "document" as const,
  format: "markdown" as const,
  source: "same body",
  title: "Notes",
  bytes: 9,
  redacted: false,
}

it("reuses an active source with the same Twin fingerprint", async () => {
  const first = await registerTwinSource(draft)
  const second = await registerTwinSource({ ...draft, title: "Duplicate title" })

  expect(first.created).toBe(true)
  expect(second).toMatchObject({ created: false, revived: false })
  expect(second.source.id).toBe(first.source.id)
  expect(await getDb().twinSources.count()).toBe(1)
})

it("revives a failed source instead of creating a duplicate", async () => {
  const first = await registerTwinSource(draft)
  await updateTwinSource(first.source.id, { status: "failed", errorMessage: "offline" })

  const retried = await registerTwinSource({ ...draft, title: "Retried notes" })

  expect(retried).toMatchObject({ created: false, revived: true })
  expect(retried.source).toMatchObject({
    id: first.source.id,
    title: "Retried notes",
    status: "pending",
    chunkCount: 0,
  })
  expect(retried.source.errorMessage).toBeUndefined()
})

it("isolates identical content by Twin", async () => {
  const first = await registerTwinSource(draft)
  const second = await registerTwinSource({ ...draft, twinId: "twin-b" })

  expect(second.source.id).not.toBe(first.source.id)
  expect(await getDb().twinSources.count()).toBe(2)
})
