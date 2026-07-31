import type { AppSettings } from "@cognia/agent-config-types"
import { DEFAULTS } from "@/lib/db/settings"
import {
  valuesEqual,
  diffFromDefaults,
  groupChangedBySection,
  humanizeSettingKey,
  previewValue,
} from "./changed-settings"

describe("valuesEqual", () => {
  it("treats primitives by value", () => {
    expect(valuesEqual(1, 1)).toBe(true)
    expect(valuesEqual("a", "a")).toBe(true)
    expect(valuesEqual(true, false)).toBe(false)
    expect(valuesEqual(1, "1")).toBe(false)
  })

  it("handles null and undefined", () => {
    expect(valuesEqual(null, null)).toBe(true)
    expect(valuesEqual(undefined, undefined)).toBe(true)
    expect(valuesEqual(null, undefined)).toBe(false)
    expect(valuesEqual(null, 0)).toBe(false)
  })

  it("compares arrays element-wise, order-sensitive", () => {
    expect(valuesEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(valuesEqual([1, 2], [2, 1])).toBe(false)
    expect(valuesEqual([], [])).toBe(true)
  })

  it("compares objects deeply, order-insensitive", () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(valuesEqual({ a: { c: [1] } }, { a: { c: [1] } })).toBe(true)
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false)
  })

  it("distinguishes arrays from objects", () => {
    expect(valuesEqual([], {})).toBe(false)
  })
})

describe("diffFromDefaults", () => {
  it("returns empty when nothing differs", () => {
    expect(diffFromDefaults({ ...DEFAULTS })).toEqual([])
  })

  it("flags a changed primitive with section + values", () => {
    const settings: AppSettings = { ...DEFAULTS, theme: "dark" }
    const diff = diffFromDefaults(settings)
    const themeRow = diff.find((d) => d.key === "theme")
    expect(themeRow).toBeDefined()
    expect(themeRow?.sectionId).toBe("appearance")
    expect(themeRow?.current).toBe("dark")
    expect(themeRow?.default).toBe(DEFAULTS.theme)
  })

  it("flags a changed nested object", () => {
    const settings: AppSettings = {
      ...DEFAULTS,
      conversationTitle: { enabled: false },
    }
    const diff = diffFromDefaults(settings)
    expect(diff.some((d) => d.key === "conversationTitle")).toBe(true)
  })

  it("ignores denylisted (secret / UI-local) keys even when changed", () => {
    const settings: AppSettings = {
      ...DEFAULTS,
      apiKey: "sk-secret",
      pinnedWorkflowIds: ["a", "b"],
      lastInboxViewedAt: 999,
    }
    const diff = diffFromDefaults(settings)
    expect(diff.map((d) => d.key)).not.toContain("apiKey")
    expect(diff.map((d) => d.key)).not.toContain("pinnedWorkflowIds")
    expect(diff.map((d) => d.key)).not.toContain("lastInboxViewedAt")
  })

  it("uses the injected defaults for comparison", () => {
    const custom: AppSettings = { ...DEFAULTS, theme: "dark" }
    expect(diffFromDefaults(custom, custom)).toEqual([])
  })
})

describe("groupChangedBySection", () => {
  it("groups by section in settings-nav order", () => {
    const settings: AppSettings = {
      ...DEFAULTS,
      ttsEnabled: !DEFAULTS.ttsEnabled,
      theme: "dark",
    }
    const groups = groupChangedBySection(diffFromDefaults(settings))
    const sectionIds = groups.map((g) => g.sectionId)
    // appearance precedes speech in the nav, so it groups first.
    expect(sectionIds).toContain("appearance")
    expect(sectionIds).toContain("speech")
    expect(sectionIds.indexOf("appearance")).toBeLessThan(sectionIds.indexOf("speech"))
  })

  it("puts unowned keys in a trailing group", () => {
    const groups = groupChangedBySection([
      { key: "theme", sectionId: "appearance", current: "dark", default: "system" },
      {
        key: "defaultModel" as keyof AppSettings,
        sectionId: undefined,
        current: "x",
        default: undefined,
      },
    ])
    expect(groups[groups.length - 1].sectionId).toBeUndefined()
  })
})

describe("humanizeSettingKey", () => {
  it("splits camelCase and capitalizes", () => {
    expect(humanizeSettingKey("defaultModel")).toBe("Default Model")
    expect(humanizeSettingKey("ttsAutoPlay")).toBe("Tts Auto Play")
    expect(humanizeSettingKey("biometricRequiredFor")).toBe("Biometric Required For")
  })

  it("handles snake/kebab and single words", () => {
    expect(humanizeSettingKey("source_verification")).toBe("Source Verification")
    expect(humanizeSettingKey("lsp")).toBe("Lsp")
  })
})

describe("previewValue", () => {
  it("renders primitives, empty string, and undefined", () => {
    expect(previewValue(undefined)).toBe("—")
    expect(previewValue(null)).toBe("null")
    expect(previewValue("")).toBe('""')
    expect(previewValue("dark")).toBe("dark")
    expect(previewValue(true)).toBe("true")
    expect(previewValue(42)).toBe("42")
  })

  it("summarizes arrays and objects", () => {
    expect(previewValue([1, 2, 3])).toBe("[3]")
    expect(previewValue({ a: 1 })).toBe('{"a":1}')
  })

  it("truncates long JSON", () => {
    const big = { text: "x".repeat(200) }
    expect(previewValue(big).endsWith("…")).toBe(true)
  })
})
