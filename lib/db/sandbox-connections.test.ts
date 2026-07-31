/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  putSandboxConnection,
  listSandboxConnections,
  getSandboxConnection,
  deleteSandboxConnection,
  type SandboxConnectionRow,
} from "@/lib/db/sandbox-connections"

const base: SandboxConnectionRow = {
  id: "conn-1",
  name: "home-docker",
  provider: "docker",
  image: "ghcr.io/trycua/cua-xfce:latest",
  host: "127.0.0.1",
  port: 0,
  containerId: undefined,
  lastHealthStatus: "unknown",
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().sandboxConnections.clear()
})

test("put + list + get + delete round-trips", async () => {
  await putSandboxConnection(base)
  expect(await listSandboxConnections()).toHaveLength(1)
  expect((await getSandboxConnection("conn-1"))?.name).toBe("home-docker")
  await deleteSandboxConnection("conn-1")
  expect(await getSandboxConnection("conn-1")).toBeUndefined()
})

test("list sorts newest-first by createdAt", async () => {
  await putSandboxConnection({ ...base, id: "a", createdAt: 1 })
  await putSandboxConnection({ ...base, id: "b", createdAt: 2 })
  const rows = await listSandboxConnections()
  expect(rows.map((r) => r.id)).toEqual(["b", "a"])
})
