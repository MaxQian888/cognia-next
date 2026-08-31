import type { SelectionContentType } from "@/lib/selection/classify-selection"

import {
  findAction,
  findActionByShortcutId,
  initialTargetLocale,
  isActionSuppressed,
  MAX_VISIBLE_ACTIONS,
  resolveVisibleActions,
  SELECTION_ACTIONS,
  TARGET_LOCALES,
  type SelectionActionId,
} from "./selection-toolbar-actions"

const STABLE_SIX: SelectionActionId[] = ["copy", "explain", "translate", "ask", "remember", "speak"]

function visible(
  types: SelectionContentType[],
  candidate: { origin?: string; sourceSubrole?: string } = {},
  contextualEnabled = true
) {
  return resolveVisibleActions({ types, candidate, contextualEnabled }).map((a) => a.id)
}

describe("SELECTION_ACTIONS", () => {
  it("keeps ids and shortcut ids unique", () => {
    const ids = new Set(SELECTION_ACTIONS.map((action) => action.id))
    expect(ids.size).toBe(SELECTION_ACTIONS.length)
    const shortcutIds = SELECTION_ACTIONS.map((a) => a.shortcutId).filter(Boolean)
    expect(new Set(shortcutIds).size).toBe(shortcutIds.length)
  })

  it("gives a chord to exactly the six stable actions and to nothing else", () => {
    // Contextual actions must not own chords: a shortcut that only works when
    // the selection happens to be a URL cannot become a habit, and it would
    // have to be taken from a stable action to exist.
    const withChord = SELECTION_ACTIONS.filter((a) => a.shortcutId).map((a) => a.id)
    expect(withChord).toEqual(STABLE_SIX)
    for (const action of SELECTION_ACTIONS) {
      if (action.requires !== undefined) expect(action.shortcutId).toBeUndefined()
    }
  })

  it("namespaces every shortcut id so the Rust dispatch prefix match reaches it", () => {
    // `shortcuts/registry.rs` routes on `id.starts_with("selection.")`.
    for (const action of SELECTION_ACTIONS) {
      if (action.shortcutId) expect(action.shortcutId.startsWith("selection.")).toBe(true)
    }
  })

  it("splits the actions into the four feedback modes the toolbar renders", () => {
    const byMode = (mode: string) =>
      SELECTION_ACTIONS.filter((action) => action.mode === mode).map((action) => action.id)
    expect(byMode("local")).toEqual(["copy"])
    expect(byMode("handoff")).toEqual(["explain", "translate", "ask", "convertUnit"])
    expect(byMode("await")).toEqual(["remember", "speak"])
    // `launch` hands off outside Cognia: neither we nor the main window come
    // forward, so it is the first mode where "stays open" is not simply the
    // inverse of "focuses main".
    expect(byMode("launch")).toEqual(["openLink", "composeEmail", "searchWeb"])
  })

  it("gives the locale picker to translate alone", () => {
    const withPicker = SELECTION_ACTIONS.filter((action) => action.hasLocalePicker)
    expect(withPicker.map((action) => action.id)).toEqual(["translate"])
  })

  it("looks actions up by id and by shortcut id", () => {
    expect(findAction("speak")?.shortcutId).toBe("selection.speak")
    expect(findActionByShortcutId("selection.remember")?.id).toBe("remember")
    expect(findActionByShortcutId("tray.show")).toBeUndefined()
  })

  it("never resolves a missing shortcut id to a contextual action", () => {
    // Without the guard this would match the first row whose shortcutId is
    // also undefined — i.e. `openLink`.
    expect(findActionByShortcutId(undefined)).toBeUndefined()
    expect(findActionByShortcutId("")).toBeUndefined()
  })
})

describe("resolveVisibleActions", () => {
  it("shows exactly the stable six when nothing matches", () => {
    expect(visible([])).toEqual(STABLE_SIX)
  })

  it("evicts from the tail so the contextual action takes the vacated slot", () => {
    // Row length is constant and no generic button shifts sideways — that is
    // what keeps the capsule from jumping when a URL is selected.
    const result = visible(["url"])
    expect(result).toEqual(["copy", "explain", "translate", "ask", "remember", "openLink"])
    expect(result).toHaveLength(MAX_VISIBLE_ACTIONS)
  })

  it("evicts two when two contextual actions match", () => {
    const result = visible(["url", "measurement"])
    expect(result).toEqual(["copy", "explain", "translate", "ask", "openLink", "convertUnit"])
    expect(result).toHaveLength(MAX_VISIBLE_ACTIONS)
  })

  it("never evicts copy and never evicts a matched contextual action", () => {
    const result = visible(["url", "measurement"])
    expect(result).toContain("copy")
    expect(result).toContain("openLink")
    expect(result).toContain("convertUnit")
  })

  it("never exceeds the capsule's budget", () => {
    for (const types of [
      [],
      ["url"],
      ["email"],
      ["term"],
      ["measurement"],
      ["url", "measurement"],
      ["email", "term"],
    ] as SelectionContentType[][]) {
      expect(visible(types).length).toBeLessThanOrEqual(MAX_VISIBLE_ACTIONS)
    }
  })

  it("keeps the generic actions in their canonical relative order", () => {
    const result = visible(["url"]).filter((id) => STABLE_SIX.includes(id as SelectionActionId))
    expect(result).toEqual(STABLE_SIX.filter((id) => result.includes(id)))
  })

  it("puts contextual actions at the tail", () => {
    const result = visible(["url"])
    expect(result[result.length - 1]).toBe("openLink")
  })

  it("spares translate from eviction when the text is foreign", () => {
    // Translating is now the likeliest intent, so it must not be what gets
    // dropped to make room.
    const result = visible(["foreignLanguage", "term"])
    expect(result).toContain("translate")
    expect(result).toContain("searchWeb")
  })

  it("returns the fixed six with no eviction when contextual actions are off", () => {
    expect(visible(["url", "measurement"], {}, false)).toEqual(STABLE_SIX)
  })

  it("renders nothing at all for a password field", () => {
    expect(visible(["term"], { sourceSubrole: "AXSecureTextField" })).toEqual([])
  })

  it("withholds link and email actions from OCR text but keeps search", () => {
    // An OCR'd domain is the string most likely to be misread, and opening it
    // acts on the mistake. Searching for it cannot hurt.
    expect(visible(["url"], { origin: "ocr" })).toEqual(STABLE_SIX)
    expect(visible(["email"], { origin: "ocr" })).toEqual(STABLE_SIX)
    expect(visible(["term"], { origin: "ocr" })).toContain("searchWeb")
  })
})

describe("isActionSuppressed", () => {
  const openLink = SELECTION_ACTIONS.find((a) => a.id === "openLink")!
  const searchWeb = SELECTION_ACTIONS.find((a) => a.id === "searchWeb")!
  const copy = SELECTION_ACTIONS.find((a) => a.id === "copy")!

  it("suppresses everything for a secure text field", () => {
    for (const action of [openLink, searchWeb, copy]) {
      expect(isActionSuppressed(action, { sourceSubrole: "AXSecureTextField" })).toBe(true)
    }
  })

  it("suppresses only the acting-on-it actions for OCR text", () => {
    expect(isActionSuppressed(openLink, { origin: "ocr" })).toBe(true)
    expect(isActionSuppressed(searchWeb, { origin: "ocr" })).toBe(false)
    expect(isActionSuppressed(copy, { origin: "ocr" })).toBe(false)
  })

  it("suppresses nothing for an ordinary accessibility selection", () => {
    expect(isActionSuppressed(openLink, { origin: "accessibility" })).toBe(false)
  })
})

describe("initialTargetLocale", () => {
  it("maps any Chinese tag to Simplified Chinese", () => {
    expect(initialTargetLocale("zh-CN")).toBe("zh-CN")
    expect(initialTargetLocale("zh-TW")).toBe("zh-CN")
    expect(initialTargetLocale("ZH")).toBe("zh-CN")
  })

  it("keeps a supported base language", () => {
    expect(initialTargetLocale("ja-JP")).toBe("ja")
    expect(initialTargetLocale("de")).toBe("de")
  })

  it("falls back to English for anything unsupported", () => {
    expect(initialTargetLocale("pt-BR")).toBe("en")
    expect(initialTargetLocale("")).toBe("en")
  })

  it("only ever returns a locale the picker offers", () => {
    for (const input of ["zh-TW", "ja-JP", "pt-BR", "fr-CA", ""]) {
      expect(TARGET_LOCALES).toContain(initialTargetLocale(input))
    }
  })
})

it("keeps every built-in descriptor host-local while allowing runtime ids", () => {
  for (const action of SELECTION_ACTIONS) {
    expect(action.labelKey).toBe(action.id)
    expect(action.pluginActionId).toBeUndefined()
    expect(action.isMore).toBeUndefined()
  }
})
