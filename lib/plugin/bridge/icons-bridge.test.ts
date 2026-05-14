import {
  __resetIconThemesForTesting,
  getIconTheme,
  listIconThemes,
  registerIconTheme,
  resolveFileIcon,
  subscribeIconThemes,
  unregisterIconTheme,
  unregisterIconThemesByPlugin,
} from "./icons-bridge"

const SAMPLE_THEME = JSON.stringify({
  iconDefinitions: {
    _js: { fontCharacter: "\\F1" },
    _ts: { fontCharacter: "\\F2" },
    _file: { fontCharacter: "\\F0" },
    _npm: { fontCharacter: "\\F9" },
  },
  fileExtensions: {
    js: "_js",
    ts: "_ts",
    "spec.ts": "_ts",
  },
  fileNames: {
    "package.json": "_npm",
  },
  languageIds: {
    typescript: "_ts",
  },
  file: "_file",
})

describe("icons bridge", () => {
  beforeEach(() => __resetIconThemesForTesting())

  describe("registration", () => {
    it("registers a parseable icon theme", () => {
      const theme = registerIconTheme({
        pluginId: "p",
        themeId: "material",
        name: "Material Icons",
        jsonPath: "icons/material.json",
        jsonText: SAMPLE_THEME,
      })
      expect(theme.id).toBe("p.material")
      expect(listIconThemes()).toHaveLength(1)
      expect(getIconTheme(theme.id)?.name).toBe("Material Icons")
    })

    it("throws on invalid JSON", () => {
      expect(() =>
        registerIconTheme({
          pluginId: "p",
          themeId: "x",
          name: "X",
          jsonPath: "x.json",
          jsonText: "{ not json",
        })
      ).toThrow(/Invalid JSON/)
    })

    it("throws when the JSON yields a non-object", () => {
      expect(() =>
        registerIconTheme({
          pluginId: "p",
          themeId: "x",
          name: "X",
          jsonPath: "x.json",
          jsonText: "null",
        })
      ).toThrow(/did not yield an object/)
    })

    it("strips JSON comments before parsing", () => {
      const theme = registerIconTheme({
        pluginId: "p",
        themeId: "cmt",
        name: "Cmt",
        jsonPath: "x.json",
        jsonText: `{
          // comment
          "file": "_f"
        }`,
      })
      expect(theme.data.file).toBe("_f")
    })

    it("unregisters individually + bulk by plugin", () => {
      registerIconTheme({
        pluginId: "p1",
        themeId: "a",
        name: "A",
        jsonPath: "a.json",
        jsonText: "{}",
      })
      registerIconTheme({
        pluginId: "p1",
        themeId: "b",
        name: "B",
        jsonPath: "b.json",
        jsonText: "{}",
      })
      registerIconTheme({
        pluginId: "p2",
        themeId: "c",
        name: "C",
        jsonPath: "c.json",
        jsonText: "{}",
      })
      const removed = unregisterIconThemesByPlugin("p1")
      expect(removed).toBe(2)
      expect(listIconThemes()).toHaveLength(1)
      // Idempotent
      unregisterIconTheme("p2.c")
      expect(() => unregisterIconTheme("p2.c")).not.toThrow()
    })
  })

  describe("resolveFileIcon", () => {
    let themeId: string
    beforeEach(() => {
      themeId = registerIconTheme({
        pluginId: "p",
        themeId: "material",
        name: "Material",
        jsonPath: "material.json",
        jsonText: SAMPLE_THEME,
      }).id
    })

    it("matches exact file names", () => {
      expect(resolveFileIcon(themeId, "package.json")?.fontCharacter).toBe("\\F9")
    })

    it("falls back to file extension when no exact match", () => {
      expect(resolveFileIcon(themeId, "foo.js")?.fontCharacter).toBe("\\F1")
    })

    it("matches multi-dot suffix patterns", () => {
      expect(resolveFileIcon(themeId, "thing.spec.ts")?.fontCharacter).toBe("\\F2")
    })

    it("falls back to language id when extension lookup fails", () => {
      expect(resolveFileIcon(themeId, "noext", "typescript")?.fontCharacter).toBe("\\F2")
    })

    it("falls back to the default file icon", () => {
      expect(resolveFileIcon(themeId, "weird")?.fontCharacter).toBe("\\F0")
    })

    it("returns undefined for an unknown theme id", () => {
      expect(resolveFileIcon("nope", "foo.js")).toBeUndefined()
    })

    it("returns undefined when nothing matches and there is no default", () => {
      const id = registerIconTheme({
        pluginId: "p",
        themeId: "empty",
        name: "Empty",
        jsonPath: "empty.json",
        jsonText: JSON.stringify({ iconDefinitions: {} }),
      }).id
      expect(resolveFileIcon(id, "foo.txt")).toBeUndefined()
    })
  })

  describe("subscriptions", () => {
    it("notifies on register and unregister", async () => {
      const events: string[] = []
      const dispose = subscribeIconThemes((e) => {
        events.push(`${e.type}:${e.contribution.id}`)
      })
      const theme = registerIconTheme({
        pluginId: "p",
        themeId: "x",
        name: "X",
        jsonPath: "x.json",
        jsonText: "{}",
      })
      unregisterIconTheme(theme.id)
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toEqual(["register:p.x", "unregister:p.x"])
      dispose()
    })

    it("survives listener errors", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        subscribeIconThemes(() => {
          throw new Error("boom")
        })
        registerIconTheme({
          pluginId: "p",
          themeId: "x",
          name: "X",
          jsonPath: "x.json",
          jsonText: "{}",
        })
        await new Promise((r) => setTimeout(r, 0))
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})
