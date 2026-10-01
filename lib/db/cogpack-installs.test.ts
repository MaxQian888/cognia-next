import type { CogpackInstallRow } from "@/types/plugin/plugin-cogset"

import { listCogpackInstallsFor, newCogpackInstallId, putCogpackInstall } from "./cogpack-installs"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function row(overrides: Partial<CogpackInstallRow>): CogpackInstallRow {
  return {
    id: newCogpackInstallId(),
    cogpackId: "writer",
    version: "1.0.0",
    name: "Writer",
    fingerprint: "f".repeat(64),
    trust: "unsigned",
    manifest: {
      schemaVersion: 1,
      kind: "cognia.cogpack",
      id: "writer",
      version: "1.0.0",
      name: "Writer",
      compatibility: { minHostVersion: "0.1.0" },
      members: [],
    },
    cogsetId: "cogset_1",
    missing: [],
    installedAt: 1,
    ...overrides,
  }
}

describe("cogpack installs", () => {
  it("finds every import of one cogpack, newest first", async () => {
    const older = row({ id: "a", installedAt: 1, cogsetId: "c1" })
    const newer = row({ id: "b", installedAt: 2, version: "1.1.0", cogsetId: "c2" })
    const other = row({ id: "c", installedAt: 3, cogpackId: "coder", cogsetId: "c3" })
    await putCogpackInstall(older)
    await putCogpackInstall(newer)
    await putCogpackInstall(other)

    expect((await listCogpackInstallsFor("writer")).map((r) => r.id)).toEqual(["b", "a"])
    expect(await listCogpackInstallsFor("missing")).toEqual([])
  })

  it("mints distinct install ids", () => {
    expect(newCogpackInstallId()).not.toBe(newCogpackInstallId())
    expect(newCogpackInstallId()).toMatch(/^cogpack_/)
  })
})
