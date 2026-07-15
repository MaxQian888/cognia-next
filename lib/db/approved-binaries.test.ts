/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import {
  clearApprovedBinariesForPlugin,
  findApprovedBinary,
  listApprovedBinaries,
  recordBinaryApproval,
  revokeBinaryApproval,
} from "./approved-binaries"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().approvedBinaries.clear()
})

describe("approved-binaries ledger", () => {
  it("records an approval and finds it by (pluginId, binaryPath)", async () => {
    const row = await recordBinaryApproval({
      pluginId: "acme.ext",
      binaryPath: "/plugins/acme.ext/bin/lsp",
      sha256: HASH_A,
      approvedAt: 1_700_000_000_000,
    })
    expect(row).toEqual({
      pluginId: "acme.ext",
      binaryPath: "/plugins/acme.ext/bin/lsp",
      sha256: HASH_A,
      approvedAt: 1_700_000_000_000,
    })
    expect(await findApprovedBinary("acme.ext", "/plugins/acme.ext/bin/lsp")).toEqual(row)
  })

  it("defaults approvedAt to now when the caller omits it", async () => {
    const before = Date.now()
    const row = await recordBinaryApproval({
      pluginId: "acme.ext",
      binaryPath: "/plugins/acme.ext/bin/lsp",
      sha256: HASH_A,
    })
    expect(row.approvedAt).toBeGreaterThanOrEqual(before)
    expect(row.approvedAt).toBeLessThanOrEqual(Date.now())
  })

  it("returns undefined on a miss rather than throwing", async () => {
    expect(await findApprovedBinary("nope.ext", "/plugins/nope.ext/bin/x")).toBeUndefined()
  })

  it("an approval never leaks across plugins, even for an identical path", async () => {
    await recordBinaryApproval({
      pluginId: "acme.ext",
      binaryPath: "/shared/bin/tool",
      sha256: HASH_A,
    })
    // Same path, different plugin — must be a miss. The ledger's scope is the
    // whole point: approving one plugin's binary grants nothing to another.
    expect(await findApprovedBinary("evil.ext", "/shared/bin/tool")).toBeUndefined()
  })

  it("re-approving the same path replaces the hash instead of accumulating rows", async () => {
    await recordBinaryApproval({
      pluginId: "acme.ext",
      binaryPath: "/plugins/acme.ext/bin/lsp",
      sha256: HASH_A,
      approvedAt: 1,
    })
    await recordBinaryApproval({
      pluginId: "acme.ext",
      binaryPath: "/plugins/acme.ext/bin/lsp",
      sha256: HASH_B,
      approvedAt: 2,
    })
    expect(await getDb().approvedBinaries.count()).toBe(1)
    expect(await findApprovedBinary("acme.ext", "/plugins/acme.ext/bin/lsp")).toEqual(
      expect.objectContaining({ sha256: HASH_B, approvedAt: 2 })
    )
  })

  it("revokes one approval and leaves the rest alone", async () => {
    await recordBinaryApproval({ pluginId: "a.ext", binaryPath: "/a/one", sha256: HASH_A })
    await recordBinaryApproval({ pluginId: "a.ext", binaryPath: "/a/two", sha256: HASH_B })
    await revokeBinaryApproval("a.ext", "/a/one")
    expect(await findApprovedBinary("a.ext", "/a/one")).toBeUndefined()
    expect(await findApprovedBinary("a.ext", "/a/two")).toBeDefined()
  })

  it("revoking an absent approval is a no-op", async () => {
    await expect(revokeBinaryApproval("ghost.ext", "/nowhere")).resolves.toBeUndefined()
  })

  it("lists approvals newest first, scoped by plugin or across the ledger", async () => {
    await recordBinaryApproval({
      pluginId: "a.ext",
      binaryPath: "/a/one",
      sha256: HASH_A,
      approvedAt: 100,
    })
    await recordBinaryApproval({
      pluginId: "a.ext",
      binaryPath: "/a/two",
      sha256: HASH_B,
      approvedAt: 300,
    })
    await recordBinaryApproval({
      pluginId: "b.ext",
      binaryPath: "/b/one",
      sha256: HASH_A,
      approvedAt: 200,
    })

    expect((await listApprovedBinaries("a.ext")).map((r) => r.binaryPath)).toEqual([
      "/a/two",
      "/a/one",
    ])
    expect((await listApprovedBinaries()).map((r) => r.approvedAt)).toEqual([300, 200, 100])
  })

  it("clears every approval for one plugin on uninstall", async () => {
    await recordBinaryApproval({ pluginId: "a.ext", binaryPath: "/a/one", sha256: HASH_A })
    await recordBinaryApproval({ pluginId: "a.ext", binaryPath: "/a/two", sha256: HASH_B })
    await recordBinaryApproval({ pluginId: "b.ext", binaryPath: "/b/one", sha256: HASH_A })

    expect(await clearApprovedBinariesForPlugin("a.ext")).toBe(2)
    expect(await listApprovedBinaries("a.ext")).toEqual([])
    expect(await listApprovedBinaries("b.ext")).toHaveLength(1)
  })
})
