import {
  listBrowserCredentialMeta,
  listBrowserExtensionMirror,
  replaceBrowserCredentialMeta,
  replaceBrowserExtensionMirror,
  toCredentialMetaRow,
  type BrowserCredentialMetaInput,
} from "./browser-mirrors"
import { policyForTable } from "@/lib/data-governance/table-catalog"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

const extension = (id: string, name: string) => ({
  id,
  name,
  version: "1.0.0",
  enabled: true,
  source: "webstore" as const,
  installedAt: 10,
  permissions: ["storage"],
  hostPermissions: ["https://*/*"],
  description: null,
  updateAvailable: "1.1.0",
})

describe("extension mirror", () => {
  it("replaces the whole table and lists by name", async () => {
    await replaceBrowserExtensionMirror([extension("b", "Beta"), extension("a", "Alpha")], 5)
    expect((await listBrowserExtensionMirror()).map((row) => row.id)).toEqual(["a", "b"])
    const [first] = await listBrowserExtensionMirror()
    expect(first).toEqual({
      id: "a",
      name: "Alpha",
      version: "1.0.0",
      enabled: true,
      source: "webstore",
      installedAt: 10,
      permissions: ["storage"],
      hostPermissions: ["https://*/*"],
      updateAvailable: "1.1.0",
      updatedAt: 5,
    })

    await replaceBrowserExtensionMirror([extension("c", "Gamma")], 6)
    expect((await listBrowserExtensionMirror()).map((row) => row.id)).toEqual(["c"])
  })
})

describe("credential mirror", () => {
  const credential: BrowserCredentialMetaInput = {
    id: "cred-1",
    origin: "https://example.com",
    realm: null,
    username: "me@example.com",
    source: "chrome",
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: 3,
    note: "work",
  }

  it("never persists a secret even when handed one", async () => {
    const withSecret = { ...credential, password: "hunter2" } as BrowserCredentialMetaInput
    await replaceBrowserCredentialMeta([withSecret], 9)
    const rows = await getDb().browserCredentialMeta.toArray()
    expect(JSON.stringify(rows)).not.toContain("hunter2")
    expect(rows[0]).toEqual({
      id: "cred-1",
      origin: "https://example.com",
      username: "me@example.com",
      source: "chrome",
      createdAt: 1,
      sourceUpdatedAt: 2,
      lastUsedAt: 3,
      note: "work",
      updatedAt: 9,
    })
  })

  it("replaces the table and lists by origin", async () => {
    await replaceBrowserCredentialMeta(
      [
        { ...credential, id: "z", origin: "https://z.example" },
        { ...credential, id: "a", origin: "https://a.example" },
      ],
      1
    )
    expect((await listBrowserCredentialMeta()).map((row) => row.id)).toEqual(["a", "z"])
    await replaceBrowserCredentialMeta([], 2)
    expect(await listBrowserCredentialMeta()).toEqual([])
  })

  it("keeps a realm and drops absent optionals", () => {
    const row = toCredentialMetaRow(
      { ...credential, realm: "Basic", lastUsedAt: null, note: null },
      4
    )
    expect(row.realm).toBe("Basic")
    expect(row).not.toHaveProperty("lastUsedAt")
    expect(row).not.toHaveProperty("note")
  })
})

describe("governance", () => {
  it("classifies both mirrors as rebuildable metadata caches", () => {
    for (const name of ["browserExtensionMirror", "browserCredentialMeta"]) {
      expect(policyForTable(name)).toMatchObject({
        role: "cache",
        contentProtection: "metadata-only",
        backupPolicy: { mode: "derived" },
      })
    }
  })
})
