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

    describe("case handling (VS Code lower-cases names before matching)", () => {
      let caseThemeId: string
      beforeEach(() => {
        caseThemeId = registerIconTheme({
          pluginId: "p",
          themeId: "case",
          name: "Case",
          jsonPath: "case.json",
          jsonText: JSON.stringify({
            iconDefinitions: {
              readme: { iconPath: "readme.svg" },
              docker: { iconPath: "docker.svg" },
              dockerExact: { iconPath: "docker-exact.svg" },
              image: { iconPath: "image.svg" },
              markdown: { iconPath: "markdown.svg" },
              file: { iconPath: "file.svg" },
            },
            // Themes key on lower case (Material: `readme.md`, `dockerfile`).
            fileNames: { "readme.md": "readme", dockerfile: "docker", Dockerfile: "dockerExact" },
            fileExtensions: { png: "image", md: "markdown" },
            file: "file",
          }),
        }).id
      })

      it("matches a capitalised file name against a lower-case theme key", () => {
        // README.md used to fall through to the generic markdown icon.
        expect(resolveFileIcon(caseThemeId, "README.md")?.iconPath).toBe("readme.svg")
        expect(resolveFileIcon(caseThemeId, "Readme.MD")?.iconPath).toBe("readme.svg")
      })

      it("prefers the exact spelling when the theme keys both", () => {
        expect(resolveFileIcon(caseThemeId, "Dockerfile")?.iconPath).toBe("docker-exact.svg")
        expect(resolveFileIcon(caseThemeId, "DOCKERFILE")?.iconPath).toBe("docker.svg")
      })

      it("matches an upper-case extension against a lower-case theme key", () => {
        expect(resolveFileIcon(caseThemeId, "SCREENSHOT.PNG")?.iconPath).toBe("image.svg")
        expect(resolveFileIcon(caseThemeId, "notes.Md")?.iconPath).toBe("markdown.svg")
      })

      it("never resolves an Object.prototype member as a theme key", () => {
        expect(resolveFileIcon(caseThemeId, "constructor")?.iconPath).toBe("file.svg")
        expect(resolveFileIcon(caseThemeId, "a.toString")?.iconPath).toBe("file.svg")
      })
    })

    describe("colour-scheme overrides", () => {
      let schemeThemeId: string
      beforeEach(() => {
        schemeThemeId = registerIconTheme({
          pluginId: "p",
          themeId: "schemes",
          name: "Schemes",
          jsonPath: "schemes.json",
          jsonText: JSON.stringify({
            iconDefinitions: {
              file: { iconPath: "file.svg" },
              file_light: { iconPath: "file_light.svg" },
              readme: { iconPath: "readme.svg" },
              readme_light: { iconPath: "readme_light.svg" },
              readme_hc: { iconPath: "readme_hc.svg" },
              yaml: { iconPath: "yaml.svg" },
              yaml_light: { iconPath: "yaml_light.svg" },
              ts: { iconPath: "ts.svg" },
              go: { iconPath: "go.svg" },
              go_light: { iconPath: "go_light.svg" },
            },
            file: "file",
            fileNames: { "readme.md": "readme" },
            fileExtensions: { yaml: "yaml", ts: "ts" },
            languageIds: { go: "go" },
            light: {
              file: "file_light",
              fileNames: { "readme.md": "readme_light" },
              fileExtensions: { yaml: "yaml_light" },
              languageIds: { go: "go_light" },
            },
            highContrast: { fileNames: { "readme.md": "readme_hc" } },
          }),
        }).id
      })

      it("uses the base associations under a dark theme", () => {
        expect(resolveFileIcon(schemeThemeId, "README.md")?.iconPath).toBe("readme.svg")
        expect(resolveFileIcon(schemeThemeId, "ci.yaml")?.iconPath).toBe("yaml.svg")
      })

      it("layers the light overrides key by key over the base set", () => {
        expect(resolveFileIcon(schemeThemeId, "README.md", undefined, "light")?.iconPath).toBe(
          "readme_light.svg"
        )
        expect(resolveFileIcon(schemeThemeId, "ci.yaml", undefined, "light")?.iconPath).toBe(
          "yaml_light.svg"
        )
        // Not mentioned by the light set: the base icon answers.
        expect(resolveFileIcon(schemeThemeId, "app.ts", undefined, "light")?.iconPath).toBe(
          "ts.svg"
        )
        expect(resolveFileIcon(schemeThemeId, "main.x", "go", "light")?.iconPath).toBe(
          "go_light.svg"
        )
        expect(resolveFileIcon(schemeThemeId, "notes", undefined, "light")?.iconPath).toBe(
          "file_light.svg"
        )
      })

      it("applies only the high-contrast overrides under high contrast", () => {
        expect(
          resolveFileIcon(schemeThemeId, "README.md", undefined, "highContrast")?.iconPath
        ).toBe("readme_hc.svg")
        // VS Code does not fall through to the light set for high contrast.
        expect(resolveFileIcon(schemeThemeId, "ci.yaml", undefined, "highContrast")?.iconPath).toBe(
          "yaml.svg"
        )
      })
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

// ── W5.1: enable-time manifest registration + active theme ───────────────────
jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileOps = require("@/lib/file/file-operations") as { readTextFile: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerIconThemesForPlugin, getActiveIconTheme } = require("./icons-bridge") as {
  registerIconThemesForPlugin: (
    pluginId: string,
    entries: Array<{ id: string; label: string; path: string }>,
    baseDir: string
  ) => Promise<{ registered: number; errors: string[] }>
  getActiveIconTheme: () => { id: string; baseDir?: string } | undefined
}

describe("registerIconThemesForPlugin (W5.1)", () => {
  beforeEach(() => {
    __resetIconThemesForTesting()
    fileOps.readTextFile.mockReset()
  })

  it("registers a theme read from the plugin dir with its baseDir", async () => {
    fileOps.readTextFile.mockResolvedValue(
      JSON.stringify({ iconDefinitions: { _f: { iconPath: "./icons/f.svg" } }, file: "_f" })
    )
    const result = await registerIconThemesForPlugin(
      "p1",
      [{ id: "material", label: "Material", path: "icons/theme.json" }],
      "/plugins/p1"
    )
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(getActiveIconTheme()).toMatchObject({ id: "p1.material", baseDir: "/plugins/p1" })
  })

  it("registers a browser built-in's theme from its public mirror, keeping the builtin:// root", async () => {
    // The manager passes `plugin.path` as baseDir, which for a built-in is the
    // synthetic `builtin://<id>` root. The JSON must come from the static
    // `/plugins/<id>/` mirror, and the contribution must keep the builtin root
    // so `<FileTypeIcon>` maps icon paths back onto that same mirror.
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iconDefinitions: { ts: { iconPath: "./../icons/ts.svg" } },
          file: "ts",
        }),
        { status: 200 }
      )
    )
    try {
      const result = await registerIconThemesForPlugin(
        "cognia-material-icon-theme",
        [
          {
            id: "material-icon-theme",
            label: "Material Icon Theme",
            path: "dist/material-icons.json",
          },
        ],
        "builtin://cognia-material-icon-theme"
      )
      expect(result).toEqual({ registered: 1, errors: [] })
      expect(fetchSpy).toHaveBeenCalledWith(
        "/plugins/cognia-material-icon-theme/dist/material-icons.json"
      )
      expect(fileOps.readTextFile).not.toHaveBeenCalled()
      expect(getActiveIconTheme()).toMatchObject({
        id: "cognia-material-icon-theme.material-icon-theme",
        baseDir: "builtin://cognia-material-icon-theme",
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("collects malformed JSON as a per-entry error", async () => {
    fileOps.readTextFile.mockResolvedValue("not json")
    const result = await registerIconThemesForPlugin(
      "p1",
      [{ id: "broken", label: "Broken", path: "icons/theme.json" }],
      "/plugins/p1"
    )
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
  })
})
