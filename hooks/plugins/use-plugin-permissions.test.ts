/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { resetPermissionGuard, getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { usePluginPermissions } from "./use-plugin-permissions"

beforeEach(() => {
  resetPermissionGuard()
})

describe("usePluginPermissions", () => {
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
