import {
  __resetGrammarsForTesting,
  findGrammarByScopeName,
  findGrammarsByLanguage,
  getGrammar,
  listGrammars,
  registerGrammar,
  subscribeGrammars,
  unregisterGrammar,
  unregisterGrammarsByPlugin,
  type GrammarEvent,
} from "./grammars-bridge"

const sampleJson = JSON.stringify({
  scopeName: "source.svelte",
  patterns: [{ match: "svelte", name: "keyword.svelte" }],
  fileTypes: ["svelte"],
  name: "Svelte",
})

const samplePlist = `<?xml version="1.0"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>scopeName</key>
  <string>source.svelte</string>
  <key>name</key>
  <string>Svelte</string>
</dict>
</plist>`

describe("grammars-bridge", () => {
  beforeEach(() => __resetGrammarsForTesting())

  describe("registerGrammar — JSON", () => {
    it("parses and stores a grammar", () => {
      const contribution = registerGrammar({
        pluginId: "publisher.svelte",
        scopeName: "source.svelte",
        language: "svelte",
        grammarPath: "syntaxes/svelte.tmLanguage.json",
        payload: sampleJson,
      })
      expect(contribution.id).toBe("publisher.svelte.source.svelte")
      expect(contribution.data.scopeName).toBe("source.svelte")
      expect(listGrammars()).toHaveLength(1)
      expect(getGrammar(contribution.id)).toBe(contribution)
    })

    it("rejects malformed JSON", () => {
      expect(() =>
        registerGrammar({
          pluginId: "p",
          scopeName: "s",
          grammarPath: "x",
          payload: "{ broken",
        })
      ).toThrow(/Invalid grammar JSON/)
    })

    it("rejects a payload whose scopeName disagrees with the contribution", () => {
      expect(() =>
        registerGrammar({
          pluginId: "p",
          scopeName: "source.a",
          grammarPath: "x",
          payload: JSON.stringify({ scopeName: "source.b" }),
        })
      ).toThrow(/declares scope.*targets/)
    })

    it("rejects a duplicate scope from the same plugin", () => {
      registerGrammar({
        pluginId: "p",
        scopeName: "source.x",
        grammarPath: "a",
        payload: JSON.stringify({ scopeName: "source.x" }),
      })
      expect(() =>
        registerGrammar({
          pluginId: "p",
          scopeName: "source.x",
          grammarPath: "b",
          payload: JSON.stringify({ scopeName: "source.x" }),
        })
      ).toThrow(/Grammar collision/)
    })
  })

  describe("registerGrammar — TextMate plist", () => {
    it("extracts the scope name from a plist payload", () => {
      const contribution = registerGrammar({
        pluginId: "p",
        scopeName: "source.svelte",
        grammarPath: "syntaxes/svelte.tmLanguage",
        payload: samplePlist,
      })
      expect(contribution.data.scopeName).toBe("source.svelte")
    })

    it("rejects a plist without a top-level dict", () => {
      expect(() =>
        registerGrammar({
          pluginId: "p",
          scopeName: "s",
          grammarPath: "x",
          payload: "<plist><array></array></plist>",
        })
      ).toThrow(/plist parser/)
    })
  })

  describe("unregister", () => {
    it("removes a single grammar", () => {
      const c = registerGrammar({
        pluginId: "p",
        scopeName: "source.a",
        grammarPath: "x",
        payload: JSON.stringify({ scopeName: "source.a" }),
      })
      unregisterGrammar(c.id)
      expect(listGrammars()).toHaveLength(0)
    })

    it("unregister is idempotent", () => {
      expect(() => unregisterGrammar("nope")).not.toThrow()
    })

    it("unregisterGrammarsByPlugin drops every grammar for a plugin", () => {
      registerGrammar({
        pluginId: "a",
        scopeName: "source.a",
        grammarPath: "x",
        payload: JSON.stringify({ scopeName: "source.a" }),
      })
      registerGrammar({
        pluginId: "a",
        scopeName: "source.b",
        grammarPath: "y",
        payload: JSON.stringify({ scopeName: "source.b" }),
      })
      registerGrammar({
        pluginId: "b",
        scopeName: "source.c",
        grammarPath: "z",
        payload: JSON.stringify({ scopeName: "source.c" }),
      })
      expect(unregisterGrammarsByPlugin("a")).toBe(2)
      expect(listGrammars()).toHaveLength(1)
    })
  })

  describe("lookup helpers", () => {
    it("finds grammars by language id", () => {
      registerGrammar({
        pluginId: "p",
        scopeName: "source.a",
        language: "svelte",
        grammarPath: "x",
        payload: JSON.stringify({ scopeName: "source.a" }),
      })
      registerGrammar({
        pluginId: "p",
        scopeName: "source.b",
        language: "vue",
        grammarPath: "y",
        payload: JSON.stringify({ scopeName: "source.b" }),
      })
      expect(findGrammarsByLanguage("svelte")).toHaveLength(1)
      expect(findGrammarsByLanguage("other")).toHaveLength(0)
    })

    it("finds a grammar by scope name", () => {
      registerGrammar({
        pluginId: "p",
        scopeName: "source.svelte",
        grammarPath: "x",
        payload: sampleJson,
      })
      expect(findGrammarByScopeName("source.svelte")?.scopeName).toBe("source.svelte")
      expect(findGrammarByScopeName("missing")).toBeUndefined()
    })
  })

  describe("subscribeGrammars", () => {
    it("fires for register and unregister events", async () => {
      const events: GrammarEvent[] = []
      const dispose = subscribeGrammars((e) => events.push(e))
      const c = registerGrammar({
        pluginId: "p",
        scopeName: "source.x",
        grammarPath: "x",
        payload: JSON.stringify({ scopeName: "source.x" }),
      })
      unregisterGrammar(c.id)
      await new Promise((r) => setTimeout(r, 0))
      expect(events.map((e) => e.type)).toEqual(["register", "unregister"])
      dispose()
    })

    it("survives a listener that throws", async () => {
      subscribeGrammars(() => {
        throw new Error("listener boom")
      })
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerGrammar({
          pluginId: "p",
          scopeName: "source.y",
          grammarPath: "x",
          payload: JSON.stringify({ scopeName: "source.y" }),
        })
        await new Promise((r) => setTimeout(r, 0))
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})

// ── W5.1: enable-time manifest registration ──────────────────────────────────
jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileOps = require("@/lib/file/file-operations") as { readTextFile: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerGrammarsForPlugin } = require("./grammars-bridge") as {
  registerGrammarsForPlugin: (
    pluginId: string,
    entries: Array<{ scopeName: string; language?: string; path: string }>,
    baseDir: string
  ) => Promise<{ registered: number; errors: string[] }>
}

describe("registerGrammarsForPlugin (W5.1)", () => {
  beforeEach(() => {
    __resetGrammarsForTesting()
    fileOps.readTextFile.mockReset()
  })

  it("reads the grammar file from the plugin dir and registers it", async () => {
    fileOps.readTextFile.mockResolvedValue(
      JSON.stringify({ scopeName: "source.foo", patterns: [] })
    )
    const result = await registerGrammarsForPlugin(
      "p1",
      [{ scopeName: "source.foo", language: "foo", path: "syntaxes/foo.json" }],
      "/plugins/p1"
    )
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(fileOps.readTextFile).toHaveBeenCalledWith("/plugins/p1/syntaxes/foo.json")
    expect(findGrammarByScopeName("source.foo")?.pluginId).toBe("p1")
  })

  it("rejects traversal paths and collects per-entry errors", async () => {
    fileOps.readTextFile.mockResolvedValue("{}")
    const result = await registerGrammarsForPlugin(
      "p1",
      [
        { scopeName: "source.evil", path: "../outside.json" },
        { scopeName: "", path: "syntaxes/x.json" },
      ],
      "/plugins/p1"
    )
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toMatch(/unsafe grammar path/)
  })
})
