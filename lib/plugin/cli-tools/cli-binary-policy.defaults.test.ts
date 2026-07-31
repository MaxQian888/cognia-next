/**
 * Covers the default dependency wiring of the CLI binary policy (no test
 * override): the approvals ledger, the binary hasher, and the Dexie audit
 * sink all resolve through their real module seams (mocked here at the module
 * boundary).
 *
 * These are the deps that actually gate a plugin-shipped executable in
 * production; a suite that only injects fakes would never catch the real
 * wiring pointing somewhere else.
 */

const findApprovedBinaryMock = jest.fn(
  async (_pluginId: string, _binaryPath: string) =>
    undefined as
      { pluginId: string; binaryPath: string; sha256: string; approvedAt: number } | undefined
)
jest.mock("@/lib/db/approved-binaries", () => ({
  findApprovedBinary: (pluginId: string, binaryPath: string) =>
    findApprovedBinaryMock(pluginId, binaryPath),
}))

const hashBinaryFileMock = jest.fn(async (_path: string) => null as string | null)
jest.mock("@/lib/plugin/security/binary-hash", () => ({
  hashBinaryFile: (path: string) => hashBinaryFileMock(path),
}))

const auditAddMock = jest.fn(async () => undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ automationAuditLog: { add: auditAddMock } }),
}))

import { __resetCliBinaryPolicyForTesting, evaluateCliBinary } from "./cli-binary-policy"

const HASH = "a".repeat(64)

beforeEach(() => {
  __resetCliBinaryPolicyForTesting()
  findApprovedBinaryMock.mockReset()
  findApprovedBinaryMock.mockResolvedValue(undefined)
  hashBinaryFileMock.mockReset()
  hashBinaryFileMock.mockResolvedValue(null)
  auditAddMock.mockClear()
})

afterAll(() => {
  __resetCliBinaryPolicyForTesting()
})

describe("cli-binary-policy default deps", () => {
  it("resolves approvals through lib/db/approved-binaries and hashes via binary-hash", async () => {
    findApprovedBinaryMock.mockResolvedValue({
      pluginId: "demo",
      binaryPath: "/plugins/demo/bin/tool",
      sha256: HASH,
      approvedAt: 1,
    })
    hashBinaryFileMock.mockResolvedValue(HASH)

    const decision = await evaluateCliBinary({
      pluginId: "demo",
      binaryPath: "/plugins/demo/bin/tool",
      pluginPath: "/plugins/demo",
    })

    expect(findApprovedBinaryMock).toHaveBeenCalledWith("demo", "/plugins/demo/bin/tool")
    expect(hashBinaryFileMock).toHaveBeenCalledWith("/plugins/demo/bin/tool")
    expect(decision.allowed).toBe(true)
  })

  it("writes the decision to the real automationAuditLog table", async () => {
    const decision = await evaluateCliBinary({
      pluginId: "demo",
      binaryPath: "/plugins/demo/bin/tool",
      pluginPath: "/plugins/demo",
    })
    expect(decision.allowed).toBe(false)
    expect(auditAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "plugin", pluginId: "demo", decision: "consent" })
    )
  })

  it("an unapproved binary is denied through the real ledger seam", async () => {
    findApprovedBinaryMock.mockResolvedValue(undefined)
    const decision = await evaluateCliBinary({
      pluginId: "demo",
      binaryPath: "/plugins/demo/bin/tool",
      pluginPath: "/plugins/demo",
    })
    expect(decision).toMatchObject({ allowed: false, requiresPrompt: true })
    // The ledger was consulted; the hasher was not needed.
    expect(findApprovedBinaryMock).toHaveBeenCalled()
    expect(hashBinaryFileMock).not.toHaveBeenCalled()
  })
})
