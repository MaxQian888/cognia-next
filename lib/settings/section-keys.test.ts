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

  describe("keyToSection", () => {
    it("maps a key back to its owning section", () => {
      expect(keyToSection("theme")).toBe("appearance")
      expect(keyToSection("ttsProvider")).toBe("speech")
      expect(keyToSection("networkProxy")).toBe("network")
      expect(keyToSection("biometricRequiredFor")).toBe("security")
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
