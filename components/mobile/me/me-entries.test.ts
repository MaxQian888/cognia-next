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

  it("surfaces the synced command-history viewer entry (ADR-0039)", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("command-history")).toMatchObject({
      href: "/me/command-history",
      section: "connection",
    })
  })

  it("surfaces the dormant-field preference pages (speech, web-search, conversation)", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("speech")).toMatchObject({ href: "/me/speech", section: "appearance" })
    expect(byId("web-search")).toMatchObject({ href: "/me/web-search", section: "connection" })
    expect(byId("conversation")).toMatchObject({ href: "/me/conversation", section: "appearance" })
  })

  it("includes the standalone search surface entry", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("search")).toMatchObject({ href: "/search", section: "connection" })
  })

  it("surfaces the ADR-0056 plugins, subagents, and workflow-settings entries", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("plugins")).toMatchObject({ href: "/me/plugins", section: "connection" })
    expect(byId("subagents")).toMatchObject({ href: "/me/subagents", section: "connection" })
    expect(byId("workflows-settings")).toMatchObject({
      href: "/me/workflows-settings",
      section: "automation",
    })
  })

  it("surfaces the ADR-0056 Wave 4 MCP and GitHub Delivery entries", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("mcp")).toMatchObject({ href: "/me/mcp", section: "connection" })
    expect(byId("github-delivery")).toMatchObject({
      href: "/me/github-delivery",
      section: "connection",
    })
  })

  it("surfaces the ADR-0056 Wave 4 read-only desktop-bound sections", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("slash-commands")).toMatchObject({
      href: "/me/slash-commands",
      section: "connection",
    })
    expect(byId("network")).toMatchObject({ href: "/me/network", section: "connection" })
    expect(byId("hooks")).toMatchObject({ href: "/me/hooks", section: "connection" })
    expect(byId("agent-teams-settings")).toMatchObject({
      href: "/me/agent-teams-settings",
      section: "connection",
    })
  })

  it("surfaces the platform-agnostic desktop-parity sections", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("characters")).toMatchObject({ href: "/me/characters", section: "connection" })
    expect(byId("skills")).toMatchObject({ href: "/me/skills", section: "connection" })
    expect(byId("teams")).toMatchObject({ href: "/me/teams", section: "connection" })
    expect(byId("agent-modes")).toMatchObject({ href: "/me/agent-modes", section: "connection" })
    expect(byId("a2ui")).toMatchObject({ href: "/me/a2ui", section: "connection" })
    expect(byId("artifacts")).toMatchObject({ href: "/me/artifacts", section: "appearance" })
    expect(byId("canvas")).toMatchObject({ href: "/me/canvas", section: "appearance" })
    expect(byId("memory-settings")).toMatchObject({
      href: "/me/memory-settings",
      section: "data",
    })
    expect(byId("logs")).toMatchObject({ href: "/me/logs", section: "about" })
    expect(byId("diagnostics")).toMatchObject({ href: "/me/diagnostics", section: "about" })
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

  it("handles entries without keywords (label-only match)", () => {
    const noKeywords: MeEntry = { ...entry, keywords: undefined }
    const t = (k: string) => (k === "backupRow" ? "Backup" : k)
    expect(matchMeEntry(noKeywords, "backup", t)).toBe(true)
    expect(matchMeEntry(noKeywords, "restore", t)).toBe(false)
  })
})
