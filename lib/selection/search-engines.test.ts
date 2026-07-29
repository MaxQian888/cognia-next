import {
  defaultSearchEngine,
  isSearchEngineId,
  SEARCH_ENGINES,
  SELECTION_SEARCH_ENGINE_PREF,
} from "./search-engines"

describe("search engines", () => {
  it("keeps the pref key stable", () => {
    // Changing this silently resets every user's choice.
    expect(SELECTION_SEARCH_ENGINE_PREF).toBe("selectionToolbar.searchEngine")
  })

  it("offers a closed, deduped set", () => {
    expect(new Set(SEARCH_ENGINES).size).toBe(SEARCH_ENGINES.length)
    expect(SEARCH_ENGINES).toContain("google")
    expect(SEARCH_ENGINES).toContain("baidu")
  })

  it("recognizes only ids it actually offers", () => {
    for (const id of SEARCH_ENGINES) expect(isSearchEngineId(id)).toBe(true)
    // A persisted value from an older build, or anything hostile, must not
    // reach Rust's engine table as if it were valid.
    for (const bad of ["yandex", "", null, undefined, 42, {}]) {
      expect(isSearchEngineId(bad)).toBe(false)
    }
  })

  it("defaults Chinese locales to a reachable engine", () => {
    expect(defaultSearchEngine("zh-CN")).toBe("baidu")
    expect(defaultSearchEngine("ZH")).toBe("baidu")
  })

  it("defaults everything else to google", () => {
    for (const locale of ["en-US", "ja-JP", "de", ""]) {
      expect(defaultSearchEngine(locale)).toBe("google")
    }
  })

  it("only ever returns an engine the picker offers", () => {
    for (const locale of ["zh-TW", "en-GB", "pt-BR", ""]) {
      expect(SEARCH_ENGINES).toContain(defaultSearchEngine(locale))
    }
  })
})
