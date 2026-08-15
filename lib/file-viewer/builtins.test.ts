/** @jest-environment jsdom */
import { BUILTIN_FILE_VIEWERS, RICH_PREVIEW_EXTENSIONS } from "./builtins"

describe("built-in file viewers", () => {
  it("keeps the rich-preview extension list the preview capability is derived from", () => {
    // Widening this is a product change, not a refactor: the project workbench
    // grants its `preview` capability from this list, so an extra entry makes a
    // Preview tab appear on a file kind that never had one.
    expect([...RICH_PREVIEW_EXTENSIONS]).toEqual(["md", "markdown", "html", "htm", "json"])
  })

  it("declares unique ids and the documented priority bands", () => {
    const ids = BUILTIN_FILE_VIEWERS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of BUILTIN_FILE_VIEWERS) {
      // Rich viewers at 100, the fallback at -100, and 1–99 left free for
      // future host contributions to slot between them.
      expect(entry.priority === 100 || entry.priority === -100).toBe(true)
    }
  })

  it("resolves every lazy module to a renderable component", async () => {
    // The specifiers are only typechecked otherwise, and a viewer whose module
    // fails to load shows an empty pane rather than an error.
    for (const entry of BUILTIN_FILE_VIEWERS) {
      const loaded = await entry.load()
      expect(typeof loaded.default).toBe("function")
    }
  })
})
