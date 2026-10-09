import { SYNCABLE_TABLE_NAMES } from "@/lib/sync/types"
import { PET_MIRROR_TABLES, isPetMirrorShell, isPetMirrorTable } from "./mirror"

describe("isPetMirrorShell", () => {
  it("treats the local desktop as the pet's own store", () => {
    expect(isPetMirrorShell({ platform: "tauri", remoteHostActive: () => false })).toBe(false)
  })

  it("treats a desktop driving a remote host as a mirror", () => {
    expect(isPetMirrorShell({ platform: "tauri", remoteHostActive: () => true })).toBe(true)
  })

  it.each(["mobile", "web", "headless"] as const)("treats %s as a mirror", (platform) => {
    expect(isPetMirrorShell({ platform, remoteHostActive: () => false })).toBe(true)
  })
})

describe("PET_MIRROR_TABLES", () => {
  it("names only tables companion sync actually carries", () => {
    for (const table of PET_MIRROR_TABLES) {
      expect(SYNCABLE_TABLE_NAMES).toContain(table)
    }
  })

  it("recognises a pet-table invalidation and nothing else", () => {
    expect(isPetMirrorTable("petInventory")).toBe(true)
    expect(isPetMirrorTable("sessions")).toBe(false)
    expect(isPetMirrorTable(undefined)).toBe(false)
  })
})
