const findApprovedBinaryMock = jest.fn()
const recordBinaryApprovalMock = jest.fn()
const hashBinaryFileMock = jest.fn()

jest.mock("@/lib/db/approved-binaries", () => ({
  findApprovedBinary: (...args: unknown[]) => findApprovedBinaryMock(...args),
  recordBinaryApproval: (...args: unknown[]) => recordBinaryApprovalMock(...args),
}))
jest.mock("@/lib/plugin/security/binary-hash", () => ({
  hashBinaryFile: (...args: unknown[]) => hashBinaryFileMock(...args),
}))

import { approveSiteProviderTool, assertApprovedSiteProviderTool } from "./approved-tool"

beforeEach(() => jest.clearAllMocks())

it("records explicit approval for the exact provider tool bytes", async () => {
  hashBinaryFileMock.mockResolvedValue("a".repeat(64))
  await expect(approveSiteProviderTool("/opt/cognia/wrangler")).resolves.toBe("a".repeat(64))
  expect(recordBinaryApprovalMock).toHaveBeenCalledWith({
    pluginId: "builtin:cognia-sites",
    binaryPath: "/opt/cognia/wrangler",
    sha256: "a".repeat(64),
  })
})

it("rejects relative, unapproved, and changed binaries", async () => {
  await expect(approveSiteProviderTool("wrangler")).rejects.toThrow("absolute")
  hashBinaryFileMock.mockResolvedValue("b".repeat(64))
  findApprovedBinaryMock.mockResolvedValue({ sha256: "a".repeat(64) })
  await expect(assertApprovedSiteProviderTool("/opt/cognia/wrangler")).rejects.toThrow("changed")
  findApprovedBinaryMock.mockResolvedValue({ sha256: "b".repeat(64) })
  await expect(assertApprovedSiteProviderTool("/opt/cognia/wrangler")).resolves.toBeUndefined()
})
