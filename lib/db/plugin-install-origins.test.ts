import { getInstallOrigin, putInstallOrigin } from "./plugin-install-origins"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("plugin install origins", () => {
  it("stores, replaces and deletes one origin per plugin", async () => {
    await putInstallOrigin({
      pluginId: "web-tools",
      version: "1.0.0",
      origin: { kind: "github", owner: "acme", repo: "tools", commit: "a".repeat(40) },
      recordedAt: 1,
    })
    await putInstallOrigin({
      pluginId: "web-tools",
      version: "1.1.0",
      origin: { kind: "local", via: "directory" },
      recordedAt: 2,
    })
    expect(await getInstallOrigin("web-tools")).toEqual({
      pluginId: "web-tools",
      version: "1.1.0",
      origin: { kind: "local", via: "directory" },
      recordedAt: 2,
    })
    expect(await getDb().pluginInstallOrigins.count()).toBe(1)
  })
})
