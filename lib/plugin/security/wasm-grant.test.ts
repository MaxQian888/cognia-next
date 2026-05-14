/**
 * Tests for the WASM capability grant writer.
 */

import {
  applyWasmCapabilityGrant,
  clearWasmCapabilityGrant,
  getGrantedPreopens,
} from "./wasm-grant"
import { getPermissionGuard, resetPermissionGuard } from "./permission-guard"

beforeEach(() => {
  resetPermissionGuard()
  if (typeof localStorage !== "undefined") localStorage.clear()
})

describe("applyWasmCapabilityGrant", () => {
  it("writes each granted permission into the guard with grantedBy=user", () => {
    applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification", "filesystem:read"],
      grantedPreopens: [],
    })
    const granted = getPermissionGuard().getPluginPermissions("demo.wasm")
    expect(granted.sort()).toEqual(["filesystem:read", "notification"])
  })

  it("revokes permissions the user removed when re-running", () => {
    applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification", "filesystem:read", "process:spawn"],
      grantedPreopens: [],
    })
    applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification"],
      grantedPreopens: [],
    })
    const granted = getPermissionGuard().getPluginPermissions("demo.wasm")
    expect(granted).toEqual(["notification"])
  })

  it("persists preopens to localStorage so the host can rebuild them", () => {
    const result = applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: [],
      grantedPreopens: ["~/Documents/cognia", "/tmp/scratch"],
    })
    expect(result.preopens.sort()).toEqual(["/tmp/scratch", "~/Documents/cognia"])
    expect(getGrantedPreopens("demo.wasm").sort()).toEqual(["/tmp/scratch", "~/Documents/cognia"])
  })

  it("clears preopens when the user grants none", () => {
    applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification"],
      grantedPreopens: ["~/scratch"],
    })
    expect(getGrantedPreopens("demo.wasm")).toEqual(["~/scratch"])
    applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification"],
      grantedPreopens: [],
    })
    expect(getGrantedPreopens("demo.wasm")).toEqual([])
  })

  it("respects an explicit grantedBy override", () => {
    applyWasmCapabilityGrant(
      {
        pluginId: "demo.wasm",
        grantedPermissions: ["notification"],
        grantedPreopens: [],
      },
      { grantedBy: "system" }
    )
    const log = getPermissionGuard().getAuditLog({ limit: 5 })
    // Latest audit entry should reference the demo plugin.
    expect(log[0]?.pluginId).toBe("demo.wasm")
  })

  it("returns sorted snapshots so downstream stores are deterministic", () => {
    const result = applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["process:spawn", "notification", "filesystem:read"],
      grantedPreopens: ["/b", "/a"],
    })
    expect(result.permissions).toEqual(["filesystem:read", "notification", "process:spawn"])
    expect(result.preopens).toEqual(["/a", "/b"])
  })
})

describe("clearWasmCapabilityGrant", () => {
  it("revokes every guard grant and removes the preopen entry", () => {
    applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification", "filesystem:read"],
      grantedPreopens: ["~/scratch"],
    })
    clearWasmCapabilityGrant("demo.wasm")
    expect(getPermissionGuard().getPluginPermissions("demo.wasm")).toEqual([])
    expect(getGrantedPreopens("demo.wasm")).toEqual([])
  })

  it("is a no-op for unknown plugin ids", () => {
    expect(() => clearWasmCapabilityGrant("ghost.wasm")).not.toThrow()
  })
})

describe("getGrantedPreopens", () => {
  it("returns an empty array when nothing is stored", () => {
    expect(getGrantedPreopens("nobody")).toEqual([])
  })

  it("gracefully ignores malformed localStorage", () => {
    if (typeof localStorage === "undefined") return
    localStorage.setItem("cognia:wasm-plugin:preopens", "not json{{")
    expect(getGrantedPreopens("anything")).toEqual([])
  })
})
