import { migrateLspSettings } from "./migrate-settings"
import type { AppSettings } from "@/lib/claude/types"

type Slice = Pick<AppSettings, "lsp" | "developer">

describe("migrateLspSettings", () => {
  it("is a no-op when there are no legacy fields", () => {
    const r = migrateLspSettings({ developer: { someOtherKnob: true } as never })
    expect(r.changed).toBe(false)
  })

  it("is a no-op on empty/undefined settings", () => {
    expect(migrateLspSettings(null).changed).toBe(false)
    expect(migrateLspSettings(undefined).changed).toBe(false)
    expect(migrateLspSettings({}).changed).toBe(false)
  })

  it("moves legacy userLspServers into lsp.servers and clears the old field", () => {
    const slice: Slice = {
      developer: {
        userLspServers: [{ id: "eslint", name: "ESLint", languages: ["ts"], command: "eslint" }],
      },
    }
    const r = migrateLspSettings(slice)
    expect(r.changed).toBe(true)
    expect(r.lsp?.servers).toEqual([
      { id: "eslint", name: "ESLint", languages: ["ts"], command: "eslint" },
    ])
    expect(r.developer?.userLspServers).toBeUndefined()
  })

  it("moves legacy unsignedLspAllowed into lsp.unsignedAllowed and clears it", () => {
    const r = migrateLspSettings({ developer: { unsignedLspAllowed: true } })
    expect(r.changed).toBe(true)
    expect(r.lsp?.unsignedAllowed).toBe(true)
    expect(r.developer?.unsignedLspAllowed).toBeUndefined()
  })

  it("preserves other developer knobs", () => {
    const slice = {
      developer: { unsignedLspAllowed: true, extraFlag: 42 },
    } as unknown as Slice
    const r = migrateLspSettings(slice)
    expect((r.developer as Record<string, unknown>).extraFlag).toBe(42)
  })

  it("keeps existing lsp.servers and appends legacy entries (existing wins on id)", () => {
    const slice: Slice = {
      lsp: {
        servers: [{ id: "eslint", name: "ESLint (new)", languages: ["ts"], command: "new-eslint" }],
        enabled: true,
      },
      developer: {
        userLspServers: [
          { id: "eslint", name: "ESLint (old)", languages: ["ts"], command: "old-eslint" },
          { id: "pyright", name: "Pyright", languages: ["py"], command: "pyright" },
        ],
      },
    }
    const r = migrateLspSettings(slice)
    expect(r.lsp?.servers.map((s) => s.id)).toEqual(["eslint", "pyright"])
    // existing lsp.servers entry for "eslint" is kept, not overwritten.
    expect(r.lsp?.servers.find((s) => s.id === "eslint")?.command).toBe("new-eslint")
    expect(r.lsp?.enabled).toBe(true)
  })

  it("prefers an already-migrated unsignedAllowed over the legacy value", () => {
    const slice: Slice = {
      lsp: { servers: [], unsignedAllowed: false },
      developer: { unsignedLspAllowed: true },
    }
    const r = migrateLspSettings(slice)
    expect(r.lsp?.unsignedAllowed).toBe(false)
  })

  it("is idempotent — running on its own output reports no change", () => {
    const slice: Slice = {
      developer: {
        userLspServers: [{ id: "eslint", name: "ESLint", languages: ["ts"], command: "eslint" }],
        unsignedLspAllowed: true,
      },
    }
    const first = migrateLspSettings(slice)
    const second = migrateLspSettings({ lsp: first.lsp, developer: first.developer })
    expect(second.changed).toBe(false)
  })

  it("ignores legacy entries without an id", () => {
    const slice = {
      developer: {
        userLspServers: [
          { name: "broken", languages: [], command: "x" },
          { id: "ok", name: "ok", languages: [], command: "ok" },
        ],
      },
    } as unknown as Slice
    const r = migrateLspSettings(slice)
    expect(r.lsp?.servers.map((s) => s.id)).toEqual(["ok"])
  })
})
