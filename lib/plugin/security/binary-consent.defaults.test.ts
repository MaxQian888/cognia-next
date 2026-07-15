/**
 * Covers the default dependency wiring of the binary consent writer (no test
 * override): the prompt resolves through the real consent broker, the hash
 * through `binary-hash`, and the write through the real `approvedBinaries`
 * CRUD.
 *
 * Twin of `lib/plugin/cli-tools/cli-binary-policy.defaults.test.ts`, and for
 * the same reason: this module is the ONLY writer of the consent ledger, so a
 * suite that only injects fakes would happily pass while the real wiring
 * pointed at nothing — which is exactly the "built but never wired" defect the
 * ledger itself just suffered from.
 */

const requestBinaryMock = jest.fn(async (_req: Record<string, unknown>) => ({
  granted: false,
  remember: false,
}))
jest.mock("./consent-broker", () => ({
  getPluginConsentBroker: () => ({ requestBinary: requestBinaryMock }),
}))

const hashBinaryFileMock = jest.fn(async (_path: string) => null as string | null)
jest.mock("./binary-hash", () => ({
  hashBinaryFile: (path: string) => hashBinaryFileMock(path),
}))

const recordBinaryApprovalMock = jest.fn(async (row: Record<string, unknown>) => row)
jest.mock("@/lib/db/approved-binaries", () => ({
  recordBinaryApproval: (row: Record<string, unknown>) => recordBinaryApprovalMock(row),
}))

import { confirmBinarySpawn, __resetBinaryConsentForTesting } from "./binary-consent"

const HASH = "d".repeat(64)
const INPUT = {
  pluginId: "demo",
  permission: "cli:execute" as const,
  binaryPath: "/plugins/demo/bin/tool",
  relPath: "bin/tool",
  reason: "no recorded approval",
}

beforeEach(() => {
  __resetBinaryConsentForTesting()
  requestBinaryMock.mockReset()
  requestBinaryMock.mockResolvedValue({ granted: false, remember: false })
  hashBinaryFileMock.mockReset()
  hashBinaryFileMock.mockResolvedValue(null)
  recordBinaryApprovalMock.mockClear()
})

afterAll(() => {
  __resetBinaryConsentForTesting()
})

describe("binary-consent default deps", () => {
  it("prompts through the real consent broker's requestBinary seam", async () => {
    await confirmBinarySpawn(INPUT)
    // Must be requestBinary, not request: the plain boolean entry point cannot
    // carry the remember decision, so wiring to it would silently make the
    // durable path unreachable.
    expect(requestBinaryMock).toHaveBeenCalledWith({
      pluginId: "demo",
      permission: "cli:execute",
      reason: "no recorded approval",
      binary: { path: "/plugins/demo/bin/tool", relPath: "bin/tool" },
    })
  })

  it("hashes via binary-hash and writes through the real approvedBinaries CRUD", async () => {
    requestBinaryMock.mockResolvedValue({ granted: true, remember: true })
    hashBinaryFileMock.mockResolvedValue(HASH)

    await expect(confirmBinarySpawn(INPUT)).resolves.toEqual({ granted: true, remember: true })

    expect(hashBinaryFileMock).toHaveBeenCalledWith("/plugins/demo/bin/tool")
    expect(recordBinaryApprovalMock).toHaveBeenCalledWith({
      pluginId: "demo",
      binaryPath: "/plugins/demo/bin/tool",
      sha256: HASH,
    })
  })

  it("touches neither the hasher nor the ledger for a session-scoped answer", async () => {
    requestBinaryMock.mockResolvedValue({ granted: true, remember: false })
    await expect(confirmBinarySpawn(INPUT)).resolves.toEqual({ granted: true, remember: false })
    expect(hashBinaryFileMock).not.toHaveBeenCalled()
    expect(recordBinaryApprovalMock).not.toHaveBeenCalled()
  })

  it("does not write through the real seam when the binary cannot be hashed", async () => {
    requestBinaryMock.mockResolvedValue({ granted: true, remember: true })
    hashBinaryFileMock.mockResolvedValue(null)
    await expect(confirmBinarySpawn(INPUT)).resolves.toEqual({ granted: true, remember: false })
    expect(recordBinaryApprovalMock).not.toHaveBeenCalled()
  })
})
