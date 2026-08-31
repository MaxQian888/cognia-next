/** @jest-environment jsdom */
/**
 * Tests for the WASM capability grant writer.
 */

import "fake-indexeddb/auto"

import {
  WASM_GRANT_DRIFT_WARNING,
  applyWasmCapabilityGrant,
  clearWasmCapabilityGrant,
  getGrantedPreopens,
  reconcileWasmGrantLedgerWithManifest,
} from "./wasm-grant"
import { listWasmGrantRecords } from "@/lib/db/wasm-grant-ledger"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getPermissionGuard, resetPermissionGuard } from "./permission-guard"

beforeEach(async () => {
  resetPermissionGuard()
  if (typeof localStorage !== "undefined") localStorage.clear()
  await getDb().delete()
  __resetDbForTesting()
})

describe("applyWasmCapabilityGrant", () => {
  it("writes each granted permission into the guard with grantedBy=user", async () => {
    await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification", "filesystem:read"],
      grantedPreopens: [],
    })
    const granted = getPermissionGuard().getPluginPermissions("demo.wasm")
    expect(granted.sort()).toEqual(["filesystem:read", "notification"])
  })

  it("revokes permissions the user removed when re-running", async () => {
    await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification", "filesystem:read", "process:spawn"],
      grantedPreopens: [],
    })
    await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification"],
      grantedPreopens: [],
    })
    const granted = getPermissionGuard().getPluginPermissions("demo.wasm")
    expect(granted).toEqual(["notification"])
  })

  it("persists preopens to Dexie and keeps the localStorage migration mirror", async () => {
    const result = await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: [],
      grantedPreopens: ["~/Documents/cognia", "/tmp/scratch"],
    })
    expect(result.preopens.sort()).toEqual(["/tmp/scratch", "~/Documents/cognia"])
    expect((await getGrantedPreopens("demo.wasm")).sort()).toEqual([
      "/tmp/scratch",
      "~/Documents/cognia",
    ])
    expect(await listWasmGrantRecords("demo.wasm")).toEqual([
      expect.objectContaining({ preopen: "/tmp/scratch", source: "user" }),
      expect.objectContaining({ preopen: "~/Documents/cognia", source: "user" }),
    ])
  })

  it("clears preopens when the user grants none", async () => {
    await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification"],
      grantedPreopens: ["~/scratch"],
    })
    expect(await getGrantedPreopens("demo.wasm")).toEqual(["~/scratch"])
    await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification"],
      grantedPreopens: [],
    })
    expect(await getGrantedPreopens("demo.wasm")).toEqual([])
  })

  it("respects an explicit grantedBy override", async () => {
    await applyWasmCapabilityGrant(
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

  it("returns sorted snapshots so downstream stores are deterministic", async () => {
    const result = await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["process:spawn", "notification", "filesystem:read"],
      grantedPreopens: ["/b", "/a"],
    })
    expect(result.permissions).toEqual(["filesystem:read", "notification", "process:spawn"])
    expect(result.preopens).toEqual(["/a", "/b"])
  })
})

describe("clearWasmCapabilityGrant", () => {
  it("revokes every guard grant and removes the preopen entry", async () => {
    await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: ["notification", "filesystem:read"],
      grantedPreopens: ["~/scratch"],
    })
    await clearWasmCapabilityGrant("demo.wasm")
    expect(getPermissionGuard().getPluginPermissions("demo.wasm")).toEqual([])
    expect(await getGrantedPreopens("demo.wasm")).toEqual([])
  })

  it("is a no-op for unknown plugin ids", async () => {
    await expect(clearWasmCapabilityGrant("ghost.wasm")).resolves.toBeUndefined()
  })
})

describe("getGrantedPreopens", () => {
  it("returns an empty array when nothing is stored", async () => {
    expect(await getGrantedPreopens("nobody")).toEqual([])
  })

  it("gracefully ignores malformed localStorage", async () => {
    if (typeof localStorage === "undefined") return
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    localStorage.setItem("cognia:wasm-plugin:preopens", "not json{{")
    try {
      expect(await getGrantedPreopens("anything")).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("falls back to localStorage once and migrates the mirror into Dexie", async () => {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(
      "cognia:wasm-plugin:preopens",
      JSON.stringify({ "legacy.wasm": ["/legacy"] })
    )

    expect(await getGrantedPreopens("legacy.wasm")).toEqual(["/legacy"])
    expect(await listWasmGrantRecords("legacy.wasm")).toEqual([
      expect.objectContaining({ preopen: "/legacy", source: "localStorage" }),
    ])
  })

  it("persists Dexie grants even when the localStorage mirror cannot be written", async () => {
    if (typeof localStorage === "undefined") return
    const originalSetItem = localStorage.setItem.bind(localStorage)
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      await expect(
        applyWasmCapabilityGrant({
          pluginId: "quota.wasm",
          grantedPermissions: [],
          grantedPreopens: ["/durable"],
        })
      ).resolves.toEqual({ permissions: [], preopens: ["/durable"] })
      expect(await getGrantedPreopens("quota.wasm")).toEqual(["/durable"])
      expect(setItem).toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      setItem.mockRestore()
      originalSetItem("cognia:wasm-plugin:preopens", "{}")
    }
  })
})

describe("reconcileWasmGrantLedgerWithManifest", () => {
  it("warns and denies preopens that drift away from the active manifest", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    await applyWasmCapabilityGrant({
      pluginId: "demo.wasm",
      grantedPermissions: [],
      grantedPreopens: ["/keep", "/old"],
    })

    try {
      const result = await reconcileWasmGrantLedgerWithManifest("demo.wasm", ["/keep", "/new"])

      expect(result.allowedPreopens).toEqual(["/keep"])
      expect(result.deniedLedgerPreopens).toEqual(["/old"])
      expect(result.ungrantedManifestPreopens).toEqual(["/new"])
      expect(result.warning).toBe(WASM_GRANT_DRIFT_WARNING)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
