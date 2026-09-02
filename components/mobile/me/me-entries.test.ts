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

  it("routes the two newly-reachable settings sections", () => {
    // The registry IS the reachability: a `/me/*` route with no entry here is a
    // page nothing links to. Cloud sign-in and the Eval defaults both shipped
    // their route before their row.
    const byId = Object.fromEntries(ME_ENTRIES.map((entry) => [entry.id, entry]))
    expect(byId["cloud-account"]?.href).toBe("/me/cloud-account")
    expect(byId["cloud-account"]?.labelKey).toBe("cloudAccountRow")
    expect(byId.eval?.href).toBe("/me/eval")
    expect(byId.eval?.labelKey).toBe("evalRow")
  })

  it("exposes Source Control only through a paired host", () => {
    const sourceControl = ME_ENTRIES.find((entry) => entry.id === "source-control")
    expect(sourceControl).toMatchObject({
      href: "/source-control",
      labelKey: "sourceControlRow",
      pairedOnly: true,
    })
  })

  it("makes the new rows findable by what a user would actually type", () => {
    const cloud = ME_ENTRIES.find((entry) => entry.id === "cloud-account") as MeEntry
    const evalRow = ME_ENTRIES.find((entry) => entry.id === "eval") as MeEntry
    // Both locales: the search box is the only way to reach a row the user
    // cannot see, and a Chinese-only user typing "登录" must find it.
    expect(matchMeEntry(cloud, "logto", echo)).toBe(true)
    expect(matchMeEntry(cloud, "登录", echo)).toBe(true)
    expect(matchMeEntry(evalRow, "judge", echo)).toBe(true)
    expect(matchMeEntry(evalRow, "评估", echo)).toBe(true)
  })

  it("assigns each companion illustration to one matching core feature entry", () => {
    const spots = Object.fromEntries(
      ME_ENTRIES.filter((entry) => entry.spotIcon).map((entry) => [entry.id, entry.spotIcon])
    )

    expect(spots).toEqual({
      profile: "profile",
      sync: "device-sync",
      conversation: "chat",
      canvas: "canvas",
      agent: "digital-twin",
      connectors: "connectors",
      "web-search": "browser",
      search: "discover",
      terminal: "terminal",
      squads: "agent-teams",
      skills: "skills",
      scheduler: "scheduler",
      goals: "goals",
      "workflows-settings": "workflows",
      backup: "secure-backup",
      memory: "memory",
    })
    expect(new Set(Object.values(spots)).size).toBe(16)
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

  it("surfaces the shared model catalog on mobile", () => {
    const entry = ME_ENTRIES.find((item) => item.id === "model-catalog")
    expect(entry).toMatchObject({
      href: "/me/model-catalog",
      labelKey: "modelCatalogRow",
      section: "connection",
    })
    expect(matchMeEntry(entry as MeEntry, "offering", echo)).toBe(true)
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

  it("surfaces the ADR-0056 Wave 4 MCP entry without platform-specific integrations", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("mcp")).toMatchObject({ href: "/me/mcp", section: "connection" })
    expect(byId("github-delivery")).toBeUndefined()
  })

  it("surfaces the ADR-0056 Wave 4 read-only desktop-bound sections", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("slash-commands")).toMatchObject({
      href: "/me/slash-commands",
      section: "connection",
    })
    expect(byId("network")).toMatchObject({ href: "/me/network", section: "connection" })
    expect(byId("hooks")).toMatchObject({ href: "/me/hooks", section: "connection" })
    // Not `pairedOnly` and not `/me/…` any more. ADR-0056 D6 read agent teams
    // as a desktop-collaboration runtime a phone could only watch, and
    // ADR-0140 made a Squad host-neutral: `/squads` declares
    // `standalone: "full"`, carries no `isTauri` gate, and shows the fleet a
    // phone opens this for rather than a read-only template list.
    expect(byId("squads")).toMatchObject({ href: "/squads", section: "connection" })
    expect(byId("squads")?.pairedOnly).toBeUndefined()
  })

  /**
   * `/templates` had a full phone body and no entry point on a phone at all,
   * and `/me/chat-templates` shipped its page the same way. The registry IS the
   * reachability: a route with no row here is a page nothing links to.
   */
  it("routes the two template libraries", () => {
    const byId = (id: string) => ME_ENTRIES.find((e) => e.id === id)
    expect(byId("templates")).toMatchObject({
      href: "/templates",
      labelKey: "templatesRow",
      section: "connection",
    })
    expect(byId("chat-templates")).toMatchObject({
      href: "/me/chat-templates",
      labelKey: "chatTemplatesRow",
      section: "connection",
    })
    // Both locales — the search box is the only way to reach a row a user
    // cannot see, and the two libraries must not answer each other's query.
    expect(matchMeEntry(byId("templates") as MeEntry, "模板库", echo)).toBe(true)
    expect(matchMeEntry(byId("chat-templates") as MeEntry, "prompt", echo)).toBe(true)
    expect(matchMeEntry(byId("chat-templates") as MeEntry, "对话模板", echo)).toBe(true)
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
