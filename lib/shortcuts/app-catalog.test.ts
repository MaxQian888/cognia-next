import {
  APP_SHORTCUT_CATALOG,
  PINNED_NAV_SHORTCUT_IDS,
  PINNED_NAV_SHORTCUT_SLOTS,
  getAppShortcutDescriptor,
  getDefaultAcceptedChords,
  pinnedNavShortcutId,
} from "./app-catalog"
import { getReservedShortcutConflict } from "./reserved"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

describe("app-catalog", () => {
  it("every descriptor is app-scoped with a non-empty id and label key", () => {
    for (const descriptor of APP_SHORTCUT_CATALOG) {
      expect(descriptor.scope).toBe("app")
      expect(descriptor.id).toBeTruthy()
      expect(descriptor.labelKey).toMatch(/^settings\.shortcuts\.catalog\./)
      expect(descriptor.category).toBeTruthy()
    }
  })

  it("has unique ids", () => {
    const ids = APP_SHORTCUT_CATALOG.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("resolves a known descriptor by id", () => {
    const descriptor = getAppShortcutDescriptor("terminal.toggle")
    expect(descriptor?.defaultChord).toBe("ctrl+`")
    expect(descriptor?.when).toBe("platform.tauri")
  })

  it("returns undefined for an unknown id", () => {
    expect(getAppShortcutDescriptor("does.not.exist")).toBeUndefined()
  })

  it("returns the single default chord for a shortcut without alt chords", () => {
    expect(getDefaultAcceptedChords("app.search.focus")).toEqual(["/"])
  })

  it("includes normalized alt chords for a shortcut that declares them", () => {
    // zoom.in accepts both the plain `=` and the Shift `+` physical key.
    expect(getDefaultAcceptedChords("zoom.in")).toEqual(["ctrl+=", "ctrl+shift+="])
  })

  it("returns an empty list for an unknown id", () => {
    expect(getDefaultAcceptedChords("does.not.exist")).toEqual([])
  })
})

describe("the two ⌘K palettes", () => {
  it("share the chord under exactly opposite when-clauses", () => {
    // Same chord is deliberate — the workflow editor keeps its editor-local
    // palette (ADR-0129). What makes that safe is the exact negation: the
    // dispatcher fires the first hit whose `when` passes, so only one can.
    expect(getAppShortcutDescriptor("app.commandPalette.toggle")).toMatchObject({
      defaultChord: "ctrl+k",
      when: "!view.workflowEditor",
    })
    expect(getAppShortcutDescriptor("workflow.commandPalette.toggle")).toMatchObject({
      scope: "app",
      category: "app.workflow",
      defaultChord: "ctrl+k",
      when: "view.workflowEditor",
      labelKey: "settings.shortcuts.catalog.workflowCommandPaletteToggle",
    })
  })

  it("are the only catalog entries on ctrl+k", () => {
    const ids = APP_SHORTCUT_CATALOG.filter((d) => d.defaultChord === "ctrl+k").map((d) => d.id)
    expect(ids.sort()).toEqual(["app.commandPalette.toggle", "workflow.commandPalette.toggle"])
  })
})

describe("skills.record", () => {
  it("is registered as a desktop-only app shortcut", () => {
    // `when: "platform.tauri"` is what makes it inert in the web build with no
    // extra guard at the call site.
    const descriptor = getAppShortcutDescriptor("skills.record")
    expect(descriptor).toMatchObject({
      scope: "app",
      category: "app.skills",
      defaultChord: "ctrl+alt+r",
      when: "platform.tauri",
      labelKey: "settings.shortcuts.catalog.skillsRecord",
    })
  })

  it("does not collide with another catalog entry", () => {
    const chords = APP_SHORTCUT_CATALOG.filter(
      (d) => d.id !== "skills.record" && d.defaultChord === "ctrl+alt+r"
    )
    expect(chords).toEqual([])
  })

  it("is not a bare letter like its panel-scoped siblings", () => {
    // The other `skills.*` chords are scoped by the panel's mount; this one is
    // global, so a bare letter would swallow typing on every route.
    expect(getDefaultAcceptedChords("skills.record")).toEqual(["ctrl+alt+r"])
  })
})

describe("navigation rail shortcuts", () => {
  it("binds ⌥1…⌥9 to the nine pinned slots, in order", () => {
    expect(PINNED_NAV_SHORTCUT_SLOTS).toBe(9)
    expect(PINNED_NAV_SHORTCUT_IDS).toEqual(
      Array.from({ length: 9 }, (_, index) => pinnedNavShortcutId(index + 1))
    )
    PINNED_NAV_SHORTCUT_IDS.forEach((id, index) => {
      expect(getAppShortcutDescriptor(id)).toMatchObject({
        scope: "app",
        category: "app.navigation",
        labelKey: `settings.shortcuts.catalog.navPinned${index + 1}`,
      })
      expect(getDefaultAcceptedChords(id)).toEqual([`alt+${index + 1}`])
    })
  })

  it("claims no Alt+digit chord another entry already uses, or the OS reserves", () => {
    const pinned = new Set(PINNED_NAV_SHORTCUT_IDS)
    for (const descriptor of APP_SHORTCUT_CATALOG) {
      if (pinned.has(descriptor.id)) continue
      for (const chord of getDefaultAcceptedChords(descriptor.id)) {
        expect(chord).not.toMatch(/^alt\+[0-9]$/)
      }
    }
    for (const id of PINNED_NAV_SHORTCUT_IDS) {
      const [chord] = getDefaultAcceptedChords(id)
      for (const os of ["macos", "windows", "linux"] as const) {
        expect(getReservedShortcutConflict(chord, os)).toBeNull()
      }
    }
  })

  it("stands the web ⌘, binding down under Tauri, where the native accelerator owns it", () => {
    expect(getAppShortcutDescriptor("shell.settings.open")).toMatchObject({
      defaultChord: "ctrl+,",
      when: "!platform.tauri",
      category: "app.navigation",
    })
    const others = APP_SHORTCUT_CATALOG.filter(
      (d) => d.id !== "shell.settings.open" && d.defaultChord === "ctrl+,"
    )
    expect(others).toEqual([])
  })

  it.each([
    ["en", enMessages],
    ["zh-CN", zhMessages],
  ])("labels every new entry in %s", (_locale, messages) => {
    const catalog = messages.settings.shortcuts.catalog as Record<string, string>
    for (const id of [...PINNED_NAV_SHORTCUT_IDS, "shell.settings.open"]) {
      const key = getAppShortcutDescriptor(id)!.labelKey.replace("settings.shortcuts.catalog.", "")
      expect(catalog[key]).toEqual(expect.any(String))
    }
  })
})
