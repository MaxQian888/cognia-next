import { settingsFromPi } from "./pi"

/** The real top-level key set of `~/.pi/agent/settings.json` on Pi 0.84.1. */
const PI_SETTINGS = {
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.6-terra",
  defaultThinkingLevel: "medium",
  enabledModels: ["openai-codex/gpt-5.6-terra"],
  defaultProjectTrust: "ask",
  externalEditor: "code --wait",
  compaction: { enabled: true, keepRecentTokens: 20000 },
  retry: { enabled: true, maxRetries: 3 },
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  images: { autoResize: true },
  theme: "ocean",
  markdown: {},
  enableAnalytics: false,
  enableInstallTelemetry: false,
  showCacheMissNotices: true,
  collapseChangelog: true,
  lastChangelogVersion: "0.84.1",
  packages: ["npm:@aliou/pi-guardrails@0.17.0", "npm:pi-mcp-adapter@2.23.0"],
}

const byKey = (drafts: ReturnType<typeof settingsFromPi>, key: string) =>
  drafts.find((d) => d.key === key)

describe("settingsFromPi", () => {
  it("recombines Pi's separate provider and model into one id", () => {
    const drafts = settingsFromPi({}, PI_SETTINGS)
    expect(byKey(drafts, "defaultModel")).toMatchObject({
      target: "defaultModel",
      incoming: "openai-codex/gpt-5.6-terra",
      supported: true,
    })
  })

  it("imports a model unqualified, with a warning, when no provider is set", () => {
    const drafts = settingsFromPi({}, { defaultModel: "gpt-5.6-terra" })
    const draft = byKey(drafts, "defaultModel")!
    expect(draft.incoming).toBe("gpt-5.6-terra")
    expect(draft.warnings.join(" ")).toContain("No defaultProvider")
  })

  it("maps Pi's thinking level onto Cognia's reasoning effort", () => {
    const drafts = settingsFromPi({}, PI_SETTINGS)
    expect(byKey(drafts, "defaultThinkingLevel")).toMatchObject({
      target: "defaultEffort",
      incoming: "medium",
    })
  })

  it("treats Pi's `none` thinking level as low rather than dropping it", () => {
    const drafts = settingsFromPi({}, { defaultThinkingLevel: "none" })
    expect(byKey(drafts, "defaultThinkingLevel")!.incoming).toBe("low")
  })

  it("flags a thinking level it does not recognise instead of guessing", () => {
    const drafts = settingsFromPi({}, { defaultThinkingLevel: "ludicrous" })
    const draft = byKey(drafts, "defaultThinkingLevel")!
    expect(draft.supported).toBe(false)
    expect(draft.target).toBe("unsupported")
  })

  /**
   * `packages` is Pi's installed-extension list, owned by the Pi package
   * manager. Presenting it as an importable setting would be misleading and
   * applying it would install nothing.
   */
  it("never offers Pi's packages array as a setting", () => {
    const drafts = settingsFromPi({}, PI_SETTINGS)
    expect(byKey(drafts, "packages")).toBeUndefined()
    expect(JSON.stringify(drafts)).not.toContain("pi-guardrails")
  })

  it("reports the keys Cognia cannot represent rather than silently ignoring them", () => {
    const drafts = settingsFromPi({}, PI_SETTINGS)
    const unsupported = drafts.filter((d) => !d.supported).map((d) => d.key)
    expect(unsupported).toEqual(
      expect.arrayContaining([
        "compaction",
        "retry",
        "steeringMode",
        "followUpMode",
        "defaultProjectTrust",
        "theme",
        "enabledModels",
      ])
    )
    for (const draft of drafts.filter((d) => !d.supported)) {
      expect(draft.warnings.length).toBeGreaterThan(0)
    }
  })

  it("stamps every draft with the pi source", () => {
    for (const draft of settingsFromPi({}, PI_SETTINGS)) {
      expect(draft.source).toBe("pi")
      expect(draft.id.startsWith("pi:")).toBe(true)
    }
  })

  it("returns nothing for an empty or non-object config", () => {
    expect(settingsFromPi({}, {})).toEqual([])
    expect(settingsFromPi({}, null)).toEqual([])
    expect(settingsFromPi({}, ["not", "an", "object"])).toEqual([])
  })

  it("carries the current value through for a side-by-side diff", () => {
    const drafts = settingsFromPi({ defaultModel: "anthropic/claude-sonnet-5" }, PI_SETTINGS)
    expect(byKey(drafts, "defaultModel")!.current).toBe("anthropic/claude-sonnet-5")
  })
})
