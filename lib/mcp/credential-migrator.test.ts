import type { KeyringStore } from "@/lib/credentials/keyring-store"

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { migrateMcpCredentials } from "./credential-migrator"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function memoryStore(fail = false): KeyringStore {
  const values = new Map<string, string>()
  return {
    save: async (key, value) => {
      if (fail) throw new Error("keyring locked")
      values.set(key, value)
    },
    load: async (key) => values.get(key) ?? null,
    delete: async (key) => void values.delete(key),
  }
}

async function seed(id: string, token: string): Promise<void> {
  await getDb().mcpServers.put({
    id,
    name: id,
    transport: "stdio",
    config: { command: "tool", env: { API_TOKEN: token } },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  })
}

describe("MCP credential migrator", () => {
  it("commits verified references and is resumable", async () => {
    await seed("one", "secret")
    const store = memoryStore()
    expect((await migrateMcpCredentials({ store })).items[0]).toMatchObject({
      status: "migrated",
      migrated: 1,
    })
    expect((await getDb().mcpServers.get("one"))?.config).toEqual({
      command: "tool",
      env: { API_TOKEN: { secretRef: "mcp/one/env/API_TOKEN" } },
    })
    expect((await migrateMcpCredentials({ store })).items[0].status).toBe("unchanged")
  })

  it("preserves the legacy row when keyring verification fails", async () => {
    await seed("one", "still-usable")
    expect((await migrateMcpCredentials({ store: memoryStore(true) })).items[0].status).toBe(
      "failed"
    )
    expect((await getDb().mcpServers.get("one"))?.config).toEqual({
      command: "tool",
      env: { API_TOKEN: "still-usable" },
    })
  })

  it("honors host-reviewed false-positive corrections", async () => {
    await seed("one", "not-a-secret")
    const report = await migrateMcpCredentials({
      store: memoryStore(),
      ignoredPaths: new Map([["one", new Set(["env/API_TOKEN"])]]),
    })
    expect(report.items[0].status).toBe("unchanged")
    expect((await getDb().mcpServers.get("one"))?.config).toEqual({
      command: "tool",
      env: { API_TOKEN: "not-a-secret" },
    })
  })
})
