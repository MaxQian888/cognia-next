import { parseGithubPluginRef } from "./github-source"
import { RECOMMENDED_MARKETPLACE_SOURCES } from "./recommended-marketplace-sources"

describe("RECOMMENDED_MARKETPLACE_SOURCES", () => {
  // The list is empty today. This is the guard for the day it isn't: an entry
  // whose `repoRef` doesn't parse would render a button that throws the moment
  // it's clicked, and duplicate refs would produce two buttons that fight over
  // the same canonical row.
  it("every entry parses as a GitHub reference", () => {
    for (const source of RECOMMENDED_MARKETPLACE_SOURCES) {
      expect(() => parseGithubPluginRef(source.repoRef)).not.toThrow()
    }
  })

  it("has no duplicate repository references", () => {
    const refs = RECOMMENDED_MARKETPLACE_SOURCES.map((s) => s.repoRef)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it("every entry carries a name and a description", () => {
    for (const source of RECOMMENDED_MARKETPLACE_SOURCES) {
      expect(source.name.trim()).not.toBe("")
      expect(source.description.trim()).not.toBe("")
    }
  })
})
