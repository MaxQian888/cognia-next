import type { AppSettings } from "@cognia/agent-config-types"
import { DEFAULTS } from "@/lib/db/settings"
import { SECRET_KEYS, NON_TRANSFERABLE_KEYS } from "./profile-transfer"
import {
  SECTION_OWNED_KEYS,
  RESET_EXCLUDE,
  NON_PREFERENCE_KEYS,
  resetKeysForSection,
  keyToSection,
  isNonPreferenceKey,
  preferenceKeys,
} from "./section-keys"

describe("section-keys", () => {
  describe("completeness guard", () => {
    it("claims every canonical preference key in exactly one section", () => {
      const claimed = new Map<string, string[]>()
      for (const [section, keys] of Object.entries(SECTION_OWNED_KEYS)) {
        for (const key of keys ?? []) {
          const list = claimed.get(key) ?? []
          list.push(section)
          claimed.set(key, list)
        }
      }

      const unclaimed: string[] = []
      for (const key of preferenceKeys()) {
        if (!claimed.has(key)) unclaimed.push(key)
      }
      expect(unclaimed).toEqual([])

      // A preference key owned by two sections would make reset/diff ambiguous.
      const duplicated = preferenceKeys().filter((k) => (claimed.get(k)?.length ?? 0) > 1)
      expect(duplicated).toEqual([])
    })

    it("does not claim any denylisted (secret / identity / UI-local) key", () => {
      const denylisted = new Set<string>([
        ...SECRET_KEYS,
        ...NON_TRANSFERABLE_KEYS,
        ...NON_PREFERENCE_KEYS,
      ])
      const owned = new Set<string>(Object.values(SECTION_OWNED_KEYS).flat())
      const leaked = [...denylisted].filter((k) => owned.has(k))
      expect(leaked).toEqual([])
    })

    it("every owned key is a real AppSettings key (compile-time enforced, runtime smoke)", () => {
      // The map's type is Partial<Record<SettingsSectionId, (keyof AppSettings)[]>>,
      // so TS already rejects bogus keys. This asserts the array is non-empty.
      for (const [, keys] of Object.entries(SECTION_OWNED_KEYS)) {
        expect(Array.isArray(keys)).toBe(true)
        expect((keys ?? []).length).toBeGreaterThan(0)
      }
    })
  })

  describe("resetKeysForSection", () => {
    it("returns the owned keys for a mapped section", () => {
      expect(resetKeysForSection("security")).toContain("biometricRequiredFor")
      expect(resetKeysForSection("sandbox")).toEqual(
        expect.arrayContaining(["sandboxDefaultEnabled", "sandboxTier", "automationPolicy"])
      )
      expect(resetKeysForSection("subscription")).toEqual(
        expect.arrayContaining(["limitsQueryEnabledAccounts", "customLimitsSources"])
      )
      expect(resetKeysForSection("data")).toEqual(
        expect.arrayContaining(["telemetryEnabled", "behaviorTelemetry", "storageRetention"])
      )
    })

    it("returns undefined for a Dexie-backed section with no owned keys", () => {
      expect(resetKeysForSection("plugins")).toBeUndefined()
      expect(resetKeysForSection("mcp")).toBeUndefined()
      expect(resetKeysForSection("characters")).toBeUndefined()
    })

    it("drops RESET_EXCLUDE keys so a reset preserves them (wallpapers)", () => {
      // wallpapers stays OWNED (changed-settings review + completeness guard)…
      expect(SECTION_OWNED_KEYS.appearance).toContain("wallpapers")
      // …but is NOT in the reset set, so user-uploaded images survive a reset.
      const resetKeys = resetKeysForSection("appearance")
      expect(resetKeys).toBeDefined()
      expect(resetKeys).not.toContain("wallpapers")
      // Other appearance keys still reset.
      expect(resetKeys).toEqual(expect.arrayContaining(["theme", "colorTheme", "background"]))
    })

    it("declares wallpapers as the appearance reset exclusion", () => {
      expect(RESET_EXCLUDE.appearance).toEqual(["wallpapers"])
    })
  })

  describe("newly wired appearance behaviors", () => {
    it("owns autoMode / monacoLink / customCssScope", () => {
      expect(SECTION_OWNED_KEYS.appearance).toEqual(
        expect.arrayContaining(["autoMode", "monacoLink", "customCssScope"])
      )
    })
  })

  describe("message presentation + conversation surfaces (ADR-0127)", () => {
    it("appearance owns messageDisplay, its legacy fallback, typography, usage display and theme pack", () => {
      expect(SECTION_OWNED_KEYS.appearance).toEqual(
        expect.arrayContaining([
          "messageDisplay",
          "agentFlowMode",
          "typographyExt",
          "usageDisplayMode",
          "activeThemePackId",
        ])
      )
      expect(keyToSection("messageDisplay")).toBe("appearance")
      expect(keyToSection("typographyExt")).toBe("appearance")
    })

    it("conversation owns the run-status-bar and composer knobs", () => {
      expect(SECTION_OWNED_KEYS.conversation).toEqual(
        expect.arrayContaining(["runStatusBar", "composerBehavior", "composerAssistance"])
      )
      expect(keyToSection("runStatusBar")).toBe("conversation")
      expect(keyToSection("composerAssistance")).toBe("conversation")
    })

    it("those keys are canonical DEFAULTS keys, so the completeness guard covers them", () => {
      // Before ADR-0127 none of these were in DEFAULTS, so the guard passed
      // while reset / review / transfer silently skipped them.
      for (const key of [
        "messageDisplay",
        "typographyExt",
        "usageDisplayMode",
        "activeThemePackId",
        "runStatusBar",
        "composerBehavior",
        "composerAssistance",
      ] as const) {
        expect(Object.prototype.hasOwnProperty.call(DEFAULTS, key)).toBe(true)
      }
      // The legacy fallback must stay undefined (never overrides a preset).
      expect(DEFAULTS.agentFlowMode).toBeUndefined()
      expect(resetKeysForSection("appearance")).toEqual(
        expect.arrayContaining(["messageDisplay", "typographyExt"])
      )
    })
  })

  describe("workbench rail", () => {
    it("owns both rail keys, not just the layout", () => {
      // The workbench customizer writes `workbenchRail` and
      // `workbenchRailPersistent` from the same panel. Claiming only the first
      // made "reset this section" leave the rail-persistence switch behind and
      // kept it out of the changed-settings review. Neither key is in DEFAULTS
      // (both fall back at the read site), so the completeness guard above
      // cannot catch this one.
      expect(SECTION_OWNED_KEYS.sidebar).toEqual(
        expect.arrayContaining(["workbenchRail", "workbenchRailPersistent"])
      )
      expect(resetKeysForSection("sidebar")).toContain("workbenchRailPersistent")
      expect(keyToSection("workbenchRailPersistent")).toBe("sidebar")
    })
  })

  describe("keyToSection", () => {
    it("maps a key back to its owning section", () => {
      expect(keyToSection("theme")).toBe("appearance")
      expect(keyToSection("ttsProvider")).toBe("speech")
      expect(keyToSection("localOpenaiBaseUrl")).toBe("speech")
      expect(keyToSection("networkProxy")).toBe("network")
      expect(keyToSection("biometricRequiredFor")).toBe("security")
      expect(keyToSection("customLimitsSources")).toBe("subscription")
      expect(keyToSection("behaviorTelemetry")).toBe("data")
    })

    it("returns undefined for an unowned / denylisted key", () => {
      expect(keyToSection("apiKey")).toBeUndefined()
      expect(keyToSection("pinnedWorkflowIds")).toBeUndefined()
    })
  })

  describe("isNonPreferenceKey", () => {
    it("flags secrets, identity, and UI-local keys", () => {
      expect(isNonPreferenceKey("apiKey")).toBe(true)
      expect(isNonPreferenceKey("id")).toBe(true)
      expect(isNonPreferenceKey("searchUsageStats")).toBe(true)
      expect(isNonPreferenceKey("pinnedWorkflowIds")).toBe(true)
    })

    it("does not flag a real preference key", () => {
      expect(isNonPreferenceKey("theme")).toBe(false)
      expect(isNonPreferenceKey("defaultModel")).toBe(false)
    })
  })

  describe("preferenceKeys", () => {
    it("is a subset of DEFAULTS keys and excludes denylisted keys", () => {
      const defaultKeys = new Set(Object.keys(DEFAULTS))
      for (const k of preferenceKeys()) {
        expect(defaultKeys.has(k)).toBe(true)
        expect(isNonPreferenceKey(k)).toBe(false)
      }
    })

    it("excludes secret keys present in DEFAULTS", () => {
      const keys = preferenceKeys() as string[]
      expect(keys).not.toContain("apiKey")
      expect(keys).not.toContain("apiBaseUrl")
    })
  })
})

// Type-level guard: NON_PREFERENCE_KEYS must be AppSettings keys.
const _typecheck: (keyof AppSettings)[] = [...NON_PREFERENCE_KEYS]
void _typecheck

describe("section ids match the navigation", () => {
  // The standalone `providers` / `profile` sections were merged into
  // `ai-connections` / `account`, and this map kept the retired ids — so the
  // default landing section answered `undefined` and rendered no reset button.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SETTINGS_NAV } = require("@/components/settings/settings-nav-config") as {
    SETTINGS_NAV: { id: string }[]
  }
  const navIds = new Set(SETTINGS_NAV.map((n) => n.id))

  it("scans a non-empty navigation", () => {
    expect(navIds.size).toBeGreaterThan(20)
  })

  it("keys every owned-key entry on a section the sidebar can actually show", () => {
    const stale = Object.keys(SECTION_OWNED_KEYS).filter((id) => !navIds.has(id))
    expect(stale).toEqual([])
  })

  it("keys every reset-exclusion on a navigable section too", () => {
    const stale = Object.keys(RESET_EXCLUDE).filter((id) => !navIds.has(id))
    expect(stale).toEqual([])
  })

  it("maps every key back to a navigable section", () => {
    const keys = Object.values(SECTION_OWNED_KEYS).flat() as (keyof AppSettings)[]
    expect(keys.length).toBeGreaterThan(0)
    const unreachable = keys
      .map((k) => keyToSection(k))
      .filter((id): id is string => Boolean(id) && !navIds.has(id as string))
    expect(unreachable).toEqual([])
  })

  it("gives the default landing section a reset affordance", () => {
    expect(resetKeysForSection("ai-connections")).toEqual(
      expect.arrayContaining(["providerSettings", "customProviders"])
    )
  })

  it("still resolves a retired id from an old deep link", () => {
    expect(resetKeysForSection("providers" as never)).toEqual(resetKeysForSection("ai-connections"))
    expect(resetKeysForSection("profile" as never)).toEqual(resetKeysForSection("account"))
  })
})
