/**
 * Covers the default dependency wiring of the LSP binary policy (no test
 * override): the approvals ledger, the binary hasher, the Dexie audit sink,
 * and the dev-mode settings toggle all resolve through their real module
 * seams (mocked here at the module boundary).
 *
 * This matters beyond coverage: `evaluateLspBinary`'s *production* deps are
 * what actually gate `child_process.spawn`. A test that only ever injects
 * fakes would never notice the real wiring pointing at the wrong table.
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
const settingsGetMock = jest.fn(
  async () => undefined as { developer?: { unsignedLspAllowed?: boolean } } | undefined
)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    automationAuditLog: { add: auditAddMock },
    settings: { get: settingsGetMock },
  }),
}))

import { __resetLspBinaryPolicyForTesting, evaluateLspBinary } from "./lsp-binary-policy"

const HASH = "a".repeat(64)

beforeEach(() => {
  __resetLspBinaryPolicyForTesting()
  findApprovedBinaryMock.mockReset()
  findApprovedBinaryMock.mockResolvedValue(undefined)
  hashBinaryFileMock.mockReset()
  hashBinaryFileMock.mockResolvedValue(null)
  auditAddMock.mockClear()
  settingsGetMock.mockReset()
  settingsGetMock.mockResolvedValue(undefined)
})

afterAll(() => {
  __resetLspBinaryPolicyForTesting()
})

describe("lsp-binary-policy default deps", () => {
  it("resolves approvals through lib/db/approved-binaries and hashes via binary-hash", async () => {
    findApprovedBinaryMock.mockResolvedValue({
      pluginId: "p",
      binaryPath: "/plugins/p/bin/lsp",
      sha256: HASH,
      approvedAt: 1,
    })
    hashBinaryFileMock.mockResolvedValue(HASH)

    const result = await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/bin/lsp",
      pluginPath: "/plugins/p",
    })

    expect(findApprovedBinaryMock).toHaveBeenCalledWith("p", "/plugins/p/bin/lsp")
    expect(hashBinaryFileMock).toHaveBeenCalledWith("/plugins/p/bin/lsp")
    expect(result.allowed).toBe(true)
  })

  it("writes the decision to the real automationAuditLog table", async () => {
    await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/bin/lsp",
      pluginPath: "/plugins/p",
    })
    expect(auditAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "plugin", pluginId: "p", decision: "consent" })
    )
  })

  it("reads the dev toggle from settings.developer.unsignedLspAllowed", async () => {
    settingsGetMock.mockResolvedValue({ developer: { unsignedLspAllowed: true } })
    const result = await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/bin/lsp",
      pluginPath: "/plugins/p",
    })
    expect(settingsGetMock).toHaveBeenCalledWith("singleton")
    expect(result.allowed).toBe(true)
    expect(result.reason).toMatch(/dev-mode override/i)
  })

  it("treats an unreadable settings store as toggle-off", async () => {
    settingsGetMock.mockRejectedValue(new Error("dexie down"))
    const result = await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/bin/lsp",
      pluginPath: "/plugins/p",
    })
    expect(result.allowed).toBe(false)
  })

  it("short-circuits the dev toggle in production builds", async () => {
    const prev = process.env.NODE_ENV
    // NODE_ENV is readonly in @types/node; the policy reads it at call time.
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    settingsGetMock.mockResolvedValue({ developer: { unsignedLspAllowed: true } })
    try {
      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin/lsp",
        pluginPath: "/plugins/p",
      })
      // The release bundle must never consult the toggle at all.
      expect(settingsGetMock).not.toHaveBeenCalled()
      expect(result.allowed).toBe(false)
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = prev
    }
  })
})
