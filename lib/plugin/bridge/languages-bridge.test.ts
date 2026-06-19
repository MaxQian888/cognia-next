import {
  __resetLanguagesForTesting,
  detectLanguage,
  getLanguage,
  listLanguages,
  registerLanguage,
  registerLanguagesForPlugin,
  subscribeLanguages,
  unregisterLanguage,
  unregisterLanguagesByPlugin,
  type LanguageEvent,
} from "./languages-bridge"

describe("languages-bridge", () => {
  beforeEach(() => __resetLanguagesForTesting())

  describe("registerLanguagesForPlugin", () => {
    it("maps manifest VsCodeLanguage entries onto contribution records", () => {
      const records = registerLanguagesForPlugin("p", [
        {
          id: "svelte",
          extensions: [".svelte"],
          aliases: ["Svelte"],
          configuration: "language-configuration.json",
          icon: { light: "l.svg", dark: "d.svg" },
        },
      ])
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        id: "svelte",
        contributionId: "p.svelte",
        configurationPath: "language-configuration.json",
        iconPathLight: "l.svg",
        iconPathDark: "d.svg",
      })
      expect(detectLanguage("App.svelte")).toBe("svelte")
    })

    it("skips a colliding entry without aborting the batch", () => {
      registerLanguage({ pluginId: "p", language: { id: "dup" } })
      const records = registerLanguagesForPlugin("p", [
        { id: "dup" }, // collision — skipped
        { id: "fresh", extensions: [".fr"] },
      ])
      expect(records.map((r) => r.id)).toEqual(["fresh"])
      expect(getLanguage("p.fresh")).toBeDefined()
    })
  })

  describe("registerLanguage", () => {
    it("stores a contribution with extensions and aliases", () => {
      const record = registerLanguage({
        pluginId: "p",
        language: {
          id: "svelte",
          extensions: [".svelte"],
          aliases: ["Svelte"],
        },
      })
      expect(record.contributionId).toBe("p.svelte")
      expect(listLanguages()).toHaveLength(1)
      expect(getLanguage(record.contributionId)).toBe(record)
    })

    it("rejects an empty id", () => {
      expect(() =>
        registerLanguage({
          pluginId: "p",
          language: { id: "", extensions: [] },
        })
      ).toThrow(/non-empty string/)
    })

    it("parses configurationText when provided", () => {
      const record = registerLanguage({
        pluginId: "p",
        language: { id: "x" },
        configurationText: JSON.stringify({
          comments: { lineComment: "//" },
          brackets: [["{", "}"]],
        }),
      })
      expect(record.configuration?.comments?.lineComment).toBe("//")
      expect(record.configuration?.brackets).toEqual([["{", "}"]])
    })

    it("rejects malformed configuration JSON", () => {
      expect(() =>
        registerLanguage({
          pluginId: "p",
          language: { id: "y" },
          configurationText: "{ broken",
        })
      ).toThrow(/Invalid language-configuration JSON/)
    })

    it("rejects a duplicate id from the same plugin", () => {
      registerLanguage({ pluginId: "p", language: { id: "x" } })
      expect(() => registerLanguage({ pluginId: "p", language: { id: "x" } })).toThrow(
        /Language collision/
      )
    })

    it("allows the same id from different plugins (independent records)", () => {
      const a = registerLanguage({ pluginId: "a", language: { id: "x" } })
      const b = registerLanguage({ pluginId: "b", language: { id: "x" } })
      expect(a.contributionId).not.toBe(b.contributionId)
      expect(listLanguages()).toHaveLength(2)
    })
  })

  describe("unregister", () => {
    it("removes a single contribution", () => {
      const r = registerLanguage({ pluginId: "p", language: { id: "x" } })
      unregisterLanguage(r.contributionId)
      expect(listLanguages()).toHaveLength(0)
    })

    it("is idempotent for unknown ids", () => {
      expect(() => unregisterLanguage("nope")).not.toThrow()
    })

    it("unregisterLanguagesByPlugin drops every contribution for a plugin", () => {
      registerLanguage({ pluginId: "a", language: { id: "x" } })
      registerLanguage({ pluginId: "a", language: { id: "y" } })
      registerLanguage({ pluginId: "b", language: { id: "z" } })
      expect(unregisterLanguagesByPlugin("a")).toBe(2)
      expect(listLanguages()).toHaveLength(1)
    })
  })

  describe("detectLanguage", () => {
    it("matches by exact filename", () => {
      registerLanguage({
        pluginId: "p",
        language: { id: "make", filenames: ["Makefile"] },
      })
      expect(detectLanguage("Makefile")).toBe("make")
      expect(detectLanguage("subdir/makefile")).toBe("make") // case-insensitive
    })

    it("matches by extension suffix", () => {
      registerLanguage({
        pluginId: "p",
        language: { id: "svelte", extensions: [".svelte"] },
      })
      expect(detectLanguage("Foo.svelte")).toBe("svelte")
      expect(detectLanguage("Foo.tsx")).toBeUndefined()
    })

    it("matches by filename pattern", () => {
      registerLanguage({
        pluginId: "p",
        language: { id: "dot-env", filenamePatterns: ["^\\.env(\\..*)?$"] },
      })
      expect(detectLanguage(".env")).toBe("dot-env")
      expect(detectLanguage(".env.local")).toBe("dot-env")
    })

    it("returns undefined when nothing matches", () => {
      expect(detectLanguage("random.bin")).toBeUndefined()
    })

    it("survives bad regex in filename patterns", () => {
      registerLanguage({
        pluginId: "p",
        language: { id: "bad", filenamePatterns: ["[unterminated"] },
      })
      expect(detectLanguage("anything.bad")).toBeUndefined()
    })
  })

  describe("subscribeLanguages", () => {
    it("fires register/unregister events", async () => {
      const events: LanguageEvent[] = []
      const dispose = subscribeLanguages((e) => events.push(e))
      const r = registerLanguage({ pluginId: "p", language: { id: "x" } })
      unregisterLanguage(r.contributionId)
      await new Promise((r) => setTimeout(r, 0))
      expect(events.map((e) => e.type)).toEqual(["register", "unregister"])
      dispose()
    })

    it("survives a listener that throws", async () => {
      subscribeLanguages(() => {
        throw new Error("listener boom")
      })
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerLanguage({ pluginId: "p", language: { id: "y" } })
        await new Promise((r) => setTimeout(r, 0))
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})
