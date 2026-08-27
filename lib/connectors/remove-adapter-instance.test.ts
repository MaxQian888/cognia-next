/**
 * Tests for lib/connectors/remove-adapter-instance.ts — the shared removal
 * path (keyring purge → attachment prune → residue reap → row delete).
 */

const mockHasCapability = jest.fn().mockReturnValue(true)
const mockServerBacked = jest.fn(() => [] as string[])
jest.mock("@/lib/platform/capabilities", () => ({
  hasCapability: (cap: string) => mockHasCapability(cap),
  serverBackedCapabilities: () => mockServerBacked(),
}))

const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringDelete: (...args: unknown[]) => mockKeyringDelete(...args),
}))

const mockEnsureLease = jest.fn().mockResolvedValue("not-required")
jest.mock("@/lib/connectors/credential-lease", () => ({
  ensureCredentialLease: () => mockEnsureLease(),
}))

const mockPrune = jest.fn().mockResolvedValue(0)
jest.mock("@/lib/connectors/attachment-fetcher", () => ({
  pruneAttachmentsForAdapter: (...args: unknown[]) => mockPrune(...args),
}))

const mockDelete = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  deleteAdapterInstance: (...args: unknown[]) => mockDelete(...args),
}))

// The reaper talks to Dexie; this suite is the node-env orchestration test, so
// it stubs the reaper the same way it stubs the prune. `adapter-residue.test.ts`
// covers the real deletes against the real schema.
const mockReap = jest.fn().mockResolvedValue({ reaped: {}, failed: [] })
jest.mock("@/lib/connectors/adapter-residue", () => ({
  reapAdapterResidue: (...args: unknown[]) => mockReap(...args),
}))

import { removeAdapterInstance } from "./remove-adapter-instance"

const ROW = {
  id: "tg-1",
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken", "extra"] },
}

beforeEach(() => {
  jest.clearAllMocks()
  mockHasCapability.mockReturnValue(true)
  mockServerBacked.mockReturnValue([])
  mockKeyringDelete.mockResolvedValue(undefined)
  mockEnsureLease.mockResolvedValue("not-required")
  mockPrune.mockResolvedValue(0)
  mockDelete.mockResolvedValue(undefined)
  mockReap.mockResolvedValue({ reaped: {}, failed: [] })
})

describe("removeAdapterInstance", () => {
  it("purges every keyring account, prunes attachments, then deletes the row — in that order", async () => {
    const order: string[] = []
    mockKeyringDelete.mockImplementation(async (_id: string, account: string) => {
      order.push(`keyring:${account}`)
    })
    mockPrune.mockImplementation(async () => {
      order.push("prune")
      return 3
    })
    mockReap.mockImplementation(async () => {
      order.push("reap")
      return { reaped: { connectorAudit: 2 }, failed: [] }
    })
    mockDelete.mockImplementation(async () => {
      order.push("delete")
    })

    const result = await removeAdapterInstance(ROW)

    // The reap must precede the row delete: a half-reaped adapter whose row
    // survives can be removed again; one whose row is gone cannot be found.
    expect(order).toEqual(["keyring:botToken", "keyring:extra", "prune", "reap", "delete"])
    expect(mockKeyringDelete).toHaveBeenCalledWith("tg-1", "botToken")
    expect(mockKeyringDelete).toHaveBeenCalledWith("tg-1", "extra")
    expect(mockPrune).toHaveBeenCalledWith("tg-1")
    expect(mockDelete).toHaveBeenCalledWith("tg-1")
    expect(result).toEqual({
      purgedCredentials: ["botToken", "extra"],
      failedCredentials: [],
      prunedAttachments: 3,
      residue: { reaped: { connectorAudit: 2 }, failed: [] },
    })
  })

  it("skips the keyring on a host with no connector runtime at all", async () => {
    mockHasCapability.mockReturnValue(false)
    mockServerBacked.mockReturnValue([])
    const result = await removeAdapterInstance(ROW)
    expect(mockKeyringDelete).not.toHaveBeenCalled()
    expect(mockPrune).toHaveBeenCalledWith("tg-1")
    expect(mockDelete).toHaveBeenCalledWith("tg-1")
    expect(result.purgedCredentials).toEqual([])
  })

  // A companion has no local connector runtime but its paired brain does, and
  // it is the brain's keyring these credentials live in. Gating on Tauri left
  // them behind under a `purgedCredentials: []` that read as "nothing to do".
  it("purges through a server-backed connector runtime", async () => {
    mockHasCapability.mockReturnValue(false)
    mockServerBacked.mockReturnValue(["connector-runtime"])
    const result = await removeAdapterInstance(ROW)
    expect(mockKeyringDelete).toHaveBeenCalled()
    expect(result.purgedCredentials.length).toBeGreaterThan(0)
  })

  it("swallows a keyring delete failure and records it, still deleting the row", async () => {
    mockKeyringDelete
      .mockRejectedValueOnce(new Error("already gone"))
      .mockResolvedValueOnce(undefined)
    const result = await removeAdapterInstance(ROW)
    expect(result.purgedCredentials).toEqual(["extra"])
    expect(result.failedCredentials).toEqual(["botToken"])
    expect(mockDelete).toHaveBeenCalledWith("tg-1")
  })

  it("swallows an attachment prune failure and still deletes the row", async () => {
    mockPrune.mockRejectedValueOnce(new Error("TransactionInactiveError"))
    const result = await removeAdapterInstance(ROW)
    expect(result.prunedAttachments).toBeNull()
    expect(mockDelete).toHaveBeenCalledWith("tg-1")
  })

  it("propagates a row-delete failure (the only non-best-effort step)", async () => {
    mockDelete.mockRejectedValueOnce(new Error("db closed"))
    await expect(removeAdapterInstance(ROW)).rejects.toThrow("db closed")
    // Secrets were still purged first so nothing is left half-cleaned.
    expect(mockKeyringDelete).toHaveBeenCalledTimes(2)
  })

  it("accepts an id-only shape (no credentialsRef) and skips the keyring loop", async () => {
    const result = await removeAdapterInstance({ id: "orphan" })
    expect(mockKeyringDelete).not.toHaveBeenCalled()
    expect(mockPrune).toHaveBeenCalledWith("orphan")
    expect(mockDelete).toHaveBeenCalledWith("orphan")
    expect(result.purgedCredentials).toEqual([])
  })
})

describe("device-plane purge", () => {
  it("takes an admin lease before deleting a remote keyring entry", async () => {
    // The purge is the one step whose refusal leaves something behind — an
    // orphaned secret under a `failedCredentials` nobody reads. Asking for the
    // lease first is what makes a removal from a phone actually destroy it.
    const order: string[] = []
    mockEnsureLease.mockImplementation(async () => {
      order.push("lease")
      return "held"
    })
    mockKeyringDelete.mockImplementation(async () => {
      order.push("delete")
    })

    await removeAdapterInstance(ROW)

    expect(order).toEqual(["lease", "delete", "delete"])
  })

  it("does not ask for a lease when there is no runtime to purge against", async () => {
    mockHasCapability.mockReturnValue(false)
    mockServerBacked.mockReturnValue([])

    await removeAdapterInstance(ROW)

    expect(mockEnsureLease).not.toHaveBeenCalled()
    expect(mockKeyringDelete).not.toHaveBeenCalled()
  })
})
