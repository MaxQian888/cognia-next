import {
  ME_ENTRIES,
  ME_SECTION_ORDER,
  ME_SECTION_TITLE_KEY,
  matchMeEntry,
  type MeEntry,
} from "./me-entries"

// A `t` that echoes the label key as its own "translation" so matching is
// deterministic without next-intl.
const echo = (key: string) => key

describe("me-entries registry", () => {
  it("assigns every entry to a known section", () => {
    for (const entry of ME_ENTRIES) {
      expect(ME_SECTION_ORDER).toContain(entry.section)
    }
  })

  it("has a title key for every section in the order", () => {
    for (const section of ME_SECTION_ORDER) {
      expect(ME_SECTION_TITLE_KEY[section]).toBeTruthy()
    }
  })

  it("uses unique ids", () => {
    const ids = ME_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("routes every entry to an absolute path", () => {
    for (const entry of ME_ENTRIES) {
      expect(entry.href.startsWith("/")).toBe(true)
    }
  })

  it("includes the newly surfaced terminal and remote-sessions entries", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("terminal")?.href).toBe("/me/terminal")
    expect(byId("remote-sessions")?.href).toBe("/remote-sessions")
  })
})

describe("matchMeEntry", () => {
  const entry: MeEntry = {
    id: "backup",
    icon: (() => null) as unknown as MeEntry["icon"],
    labelKey: "backupRow",
    href: "/me/backup",
    section: "data",
    keywords: ["restore", "备份"],
  }

  it("matches everything on an empty query", () => {
    expect(matchMeEntry(entry, "", echo)).toBe(true)
    expect(matchMeEntry(entry, "   ", echo)).toBe(true)
  })

  it("matches the localized label case-insensitively", () => {
    const t = (k: string) => (k === "backupRow" ? "Backup & restore" : k)
    expect(matchMeEntry(entry, "BACKUP", t)).toBe(true)
    expect(matchMeEntry(entry, "restore", t)).toBe(true)
  })

  it("matches an attached keyword (including Chinese)", () => {
    const t = (k: string) => (k === "backupRow" ? "Backup" : k)
    expect(matchMeEntry(entry, "备份", t)).toBe(true)
  })

  it("returns false when nothing matches", () => {
    const t = (k: string) => (k === "backupRow" ? "Backup" : k)
    expect(matchMeEntry(entry, "zzzzz", t)).toBe(false)
  })
})
