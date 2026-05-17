/**
 * @jest-environment jsdom
 *
 * Regression coverage for ADR 0016 P1-8 — legacy permission-name migration.
 */

import { migrateLegacyPermissionNames } from "./permission-migration"

jest.mock("@/lib/db/plugin-permissions", () => ({
  listAllPermissions: jest.fn(),
  revokePermission: jest.fn(),
  setPermission: jest.fn(),
}))

jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))

const {
  listAllPermissions: mockListAll,
  revokePermission: mockRevoke,
  setPermission: mockSet,
} = jest.requireMock("@/lib/db/plugin-permissions") as {
  listAllPermissions: jest.Mock
  revokePermission: jest.Mock
  setPermission: jest.Mock
}

const { recordSilentFailure: mockRecord } = jest.requireMock("../contracts/diagnostics-store") as {
  recordSilentFailure: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("migrateLegacyPermissionNames", () => {
  it("rewrites fs:read → filesystem:read and preserves the decision row", async () => {
    mockListAll.mockResolvedValue([
      {
        pluginId: "cognia-workspace-tools",
        permission: "fs:read",
        decision: "allow",
        grantedBy: "user",
        grantedAt: 1700000000000,
        expiresAt: undefined,
      },
    ])

    const result = await migrateLegacyPermissionNames()

    expect(result).toEqual({ scanned: 1, rewritten: 1 })
    expect(mockRevoke).toHaveBeenCalledWith("cognia-workspace-tools", "fs:read")
    expect(mockSet).toHaveBeenCalledWith({
      pluginId: "cognia-workspace-tools",
      permission: "filesystem:read",
      decision: "allow",
      grantedBy: "user",
      grantedAt: 1700000000000,
      expiresAt: undefined,
    })
    expect(mockRecord).toHaveBeenCalledWith(
      "cognia-workspace-tools",
      expect.objectContaining({
        site: "permission.legacy-rename",
        expected: false,
      }),
      expect.any(Error)
    )
  })

  it("rewrites fs:write → filesystem:write in the same sweep", async () => {
    mockListAll.mockResolvedValue([
      {
        pluginId: "cognia-workspace-tools",
        permission: "fs:write",
        decision: "allow",
        grantedAt: 1,
      },
    ])

    const result = await migrateLegacyPermissionNames()

    expect(result.rewritten).toBe(1)
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "filesystem:write" })
    )
  })

  it("leaves non-legacy rows untouched", async () => {
    mockListAll.mockResolvedValue([
      { pluginId: "p1", permission: "filesystem:read", decision: "allow", grantedAt: 1 },
      { pluginId: "p2", permission: "network:fetch", decision: "deny", grantedAt: 1 },
    ])

    const result = await migrateLegacyPermissionNames()

    expect(result).toEqual({ scanned: 2, rewritten: 0 })
    expect(mockRevoke).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it("is idempotent — running twice after first rewrite is a no-op", async () => {
    mockListAll.mockResolvedValueOnce([
      { pluginId: "p1", permission: "fs:read", decision: "allow", grantedAt: 1 },
    ])
    await migrateLegacyPermissionNames()
    expect(mockSet).toHaveBeenCalledTimes(1)

    // Second sweep — DB now contains only canonical rows
    jest.clearAllMocks()
    mockListAll.mockResolvedValueOnce([
      { pluginId: "p1", permission: "filesystem:read", decision: "allow", grantedAt: 1 },
    ])
    const second = await migrateLegacyPermissionNames()
    expect(second.rewritten).toBe(0)
  })

  it("records a failure diagnostic when setPermission throws", async () => {
    mockListAll.mockResolvedValue([
      { pluginId: "p1", permission: "fs:read", decision: "allow", grantedAt: 1 },
    ])
    mockSet.mockRejectedValueOnce(new Error("dexie collision"))

    const result = await migrateLegacyPermissionNames()

    expect(result.rewritten).toBe(0)
    expect(mockRecord).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ site: "permission.legacy-rename-failed" }),
      expect.any(Error)
    )
  })
})
