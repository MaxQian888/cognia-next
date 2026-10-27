/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { useMemo } from "react"
import { resetPermissionGuard, getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { usePluginPermissions } from "./use-plugin-permissions"
import {
  isPluginGatewayAvailable,
  grantPluginPermission,
  revokePluginPermission,
  listPluginPermissions,
} from "@/lib/plugin/core/transport"
import { recordSilentFailure } from "@/lib/plugin/contracts/diagnostics-store"

jest.mock("@/lib/plugin/core/transport", () => ({
  ...jest.requireActual("@/lib/plugin/core/transport"),
  isPluginGatewayAvailable: jest.fn(() => false),
  grantPluginPermission: jest.fn().mockResolvedValue(undefined),
  revokePluginPermission: jest.fn().mockResolvedValue(undefined),
  listPluginPermissions: jest.fn().mockResolvedValue([]),
}))
jest.mock("@/lib/plugin/contracts/diagnostics-store", () => ({
  ...jest.requireActual("@/lib/plugin/contracts/diagnostics-store"),
  recordSilentFailure: jest.fn(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(grantPluginPermission).mockReset().mockResolvedValue(undefined)
  jest.mocked(revokePluginPermission).mockReset().mockResolvedValue(undefined)
  jest.mocked(listPluginPermissions).mockReset().mockResolvedValue([])
  jest.mocked(isPluginGatewayAvailable).mockReturnValue(false)
  resetPermissionGuard()
})

describe("usePluginPermissions", () => {
  it("updates another permissions view after a grant or revocation", () => {
    const observer = renderHook(() => {
      const permissions = usePluginPermissions()
      return useMemo(() => permissions.getGranted("shared-view"), [permissions])
    })
    const actions = renderHook(() => usePluginPermissions())
    expect(observer.result.current).toEqual([])
    act(() => actions.result.current.grant("shared-view", "process:spawn"))
    expect(observer.result.current).toContain("process:spawn")
    act(() => actions.result.current.revoke("shared-view", "process:spawn"))
    expect(observer.result.current).not.toContain("process:spawn")
  })

  it("request preserves an existing expiring manifest grant without rewriting the host", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    const guard = getPermissionGuard()
    guard.grant("temporary", "process:spawn", { expiresIn: 1000, grantedBy: "manifest" })
    const { result } = renderHook(() => usePluginPermissions())
    let allowed = false
    await act(async () => {
      allowed = await result.current.request("temporary", "process:spawn")
    })
    expect(allowed).toBe(true)
    expect(grantPluginPermission).not.toHaveBeenCalled()
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000)
    expect(guard.check("temporary", "process:spawn")).toBe(false)
    clock.mockRestore()
  })

  it("keeps an existing grant when native writes are unavailable", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    jest.mocked(grantPluginPermission).mockRejectedValue(new Error("host unavailable"))
    getPermissionGuard().registerPlugin("existing", ["process:spawn"])
    const { result } = renderHook(() => usePluginPermissions())
    let allowed = false
    await act(async () => {
      allowed = await result.current.request("existing", "process:spawn")
    })
    expect(allowed).toBe(true)
    expect(result.current.getGranted("existing")).toContain("process:spawn")
    expect(grantPluginPermission).not.toHaveBeenCalled()
    expect(recordSilentFailure).not.toHaveBeenCalled()
  })

  it("enforces disabled runtime grants before writing to the native host", () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    getPermissionGuard({ allowRuntimeGrants: false })
    const { result } = renderHook(() => usePluginPermissions())
    expect(() => result.current.grant("native", "process:spawn")).toThrow(
      "Runtime permission grants are disabled"
    )
    expect(grantPluginPermission).not.toHaveBeenCalled()
  })

  it("rolls back a requested local grant when native persistence fails", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    jest.mocked(grantPluginPermission).mockRejectedValueOnce(new Error("host unavailable"))
    getPermissionGuard().setRequestHandler(async () => true)
    const { result } = renderHook(() => usePluginPermissions())
    let granted = true
    await act(async () => {
      granted = await result.current.request("native-request", "process:spawn")
    })
    expect(granted).toBe(false)
    expect(result.current.getGranted("native-request")).not.toContain("process:spawn")
  })
  it("confirms native revocation before showing permission as revoked", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    const guard = getPermissionGuard()
    guard.registerPlugin("native", ["process:spawn"])
    let finish!: () => void
    jest.mocked(revokePluginPermission).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => usePluginPermissions())
    act(() => result.current.revoke("native", "process:spawn"))
    expect(revokePluginPermission).toHaveBeenCalledWith("native", "process:spawn")
    expect(result.current.getGranted("native")).toContain("process:spawn")
    await act(async () => {
      finish()
      await Promise.resolve()
    })
    expect(result.current.getGranted("native")).not.toContain("process:spawn")
  })

  it("keeps a failed native revocation visible instead of claiming success", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    jest.mocked(revokePluginPermission).mockRejectedValueOnce(new Error("disk write failed"))
    getPermissionGuard().registerPlugin("native", ["process:spawn"])
    const { result } = renderHook(() => usePluginPermissions())
    await act(async () => {
      result.current.revoke("native", "process:spawn")
    })
    expect(result.current.getGranted("native")).toContain("process:spawn")
    expect(recordSilentFailure).toHaveBeenCalled()
  })

  it("mirrors user grants to the native permission ledger", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    const { result } = renderHook(() => usePluginPermissions())
    await act(async () => {
      result.current.grant("native", "process:spawn")
    })
    expect(grantPluginPermission).toHaveBeenCalledWith("native", "process:spawn", "user", undefined)
    expect(result.current.getGranted("native")).toContain("process:spawn")
  })

  it("revokeAll includes permissions that exist only in the native ledger", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
    jest.mocked(listPluginPermissions).mockResolvedValueOnce(["process:spawn"])
    getPermissionGuard().registerPlugin("native", ["clipboard:read"])
    const { result } = renderHook(() => usePluginPermissions())
    await act(async () => {
      result.current.revokeAll("native")
    })
    expect(revokePluginPermission).toHaveBeenCalledWith("native", "process:spawn")
    expect(revokePluginPermission).toHaveBeenCalledWith("native", "clipboard:read")
    expect(result.current.getGranted("native")).toEqual([])
  })
  it("exposes static groups, dangerous, and descriptions tables", () => {
    const { result } = renderHook(() => usePluginPermissions())
    expect(result.current.groups.filesystem).toContain("filesystem:read")
    expect(result.current.dangerous).toContain("shell:execute")
    expect(result.current.descriptions["clipboard:read"]).toBeTruthy()
  })

  it("grant + revoke flow drives getGranted and getHolders", () => {
    const { result } = renderHook(() => usePluginPermissions())
    act(() => result.current.grant("plugin_a", "clipboard:read"))
    expect(result.current.getGranted("plugin_a")).toContain("clipboard:read")
    expect(result.current.getHolders("clipboard:read")).toContain("plugin_a")
    act(() => result.current.revoke("plugin_a", "clipboard:read"))
    expect(result.current.getGranted("plugin_a")).not.toContain("clipboard:read")
  })

  it("revokeAll empties the plugin's permission set", () => {
    const guard = getPermissionGuard()
    guard.registerPlugin("plugin_b", ["clipboard:read", "filesystem:read"])
    const { result } = renderHook(() => usePluginPermissions())
    expect(result.current.getGranted("plugin_b").length).toBe(2)
    act(() => result.current.revokeAll("plugin_b"))
    expect(result.current.getGranted("plugin_b")).toEqual([])
  })

  it("isDangerous reflects DANGEROUS_PERMISSIONS", () => {
    const { result } = renderHook(() => usePluginPermissions())
    expect(result.current.isDangerous("shell:execute")).toBe(true)
    expect(result.current.isDangerous("clipboard:read")).toBe(false)
  })

  it("request returns true when handler grants and false when handler denies", async () => {
    const guard = getPermissionGuard()
    const { result } = renderHook(() => usePluginPermissions())

    guard.setRequestHandler(async () => true)
    let r = false
    await act(async () => {
      r = await result.current.request("plugin_c", "filesystem:read", "test")
    })
    expect(r).toBe(true)
    expect(result.current.getGranted("plugin_c")).toContain("filesystem:read")

    guard.setRequestHandler(async () => false)
    let r2 = true
    await act(async () => {
      r2 = await result.current.request("plugin_d", "network:fetch", "test")
    })
    expect(r2).toBe(false)
    expect(result.current.getGranted("plugin_d")).not.toContain("network:fetch")
  })

  it("auditLog reflects grant / revoke actions", () => {
    const { result, rerender } = renderHook(() => usePluginPermissions())
    act(() => result.current.grant("plugin_e", "clipboard:write"))
    rerender()
    expect(
      result.current.auditLog.some((e) => e.pluginId === "plugin_e" && e.action === "grant")
    ).toBe(true)
  })
})
