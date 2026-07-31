import {
  __resetSnippetsForTesting,
  listAllSnippets,
  listSnippetsForLanguage,
  registerSnippetFile,
  subscribeSnippets,
  unregisterSnippet,
  unregisterSnippetsByPlugin,
} from "./snippets-bridge"

describe("snippets bridge", () => {
  beforeEach(() => __resetSnippetsForTesting())

  it("registers snippets from a valid VS Code snippet file", () => {
    const json = JSON.stringify({
      "For Loop": {
        prefix: "for",
        body: ["for (let i = 0; i < $1; i++) {", "  $0", "}"],
        description: "C-style for loop",
      },
      ForEach: {
        prefix: ["foreach", "fe"],
        body: "${1:arr}.forEach(($2) => { $0 })",
      },
    })
    const registered = registerSnippetFile("vscode.builtin", "javascript", json)
    expect(registered).toHaveLength(2)
    expect(registered[0]?.body).toContain("for (let i = 0;")
    expect(registered[1]?.prefix).toEqual(["foreach", "fe"])
  })

  it("returns an empty list when the snippet file is malformed JSON", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(registerSnippetFile("p", "js", "{ not json")).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("strips JSON comments before parsing", () => {
    const json = `{
      // this comment must not break parsing
      "Hello": { "prefix": "hi", "body": "hello $0" }
    }`
    const registered = registerSnippetFile("p", "js", json)
    expect(registered).toHaveLength(1)
  })

  it("skips entries without prefix or body", () => {
    const json = JSON.stringify({
      Good: { prefix: "ok", body: "ok $0" },
      MissingPrefix: { body: "no prefix" },
      MissingBody: { prefix: "p" },
      EmptyPrefix: { prefix: [], body: "x" },
    })
    const registered = registerSnippetFile("p", "js", json)
    expect(registered.map((r) => r.name)).toEqual(["Good"])
  })

  it("filters snippets by language", () => {
    registerSnippetFile("p", "javascript", JSON.stringify({ A: { prefix: "a", body: "a" } }))
    registerSnippetFile("p", "python", JSON.stringify({ B: { prefix: "b", body: "b" } }))
    expect(listSnippetsForLanguage("javascript").map((s) => s.name)).toEqual(["A"])
    expect(listSnippetsForLanguage("python").map((s) => s.name)).toEqual(["B"])
    expect(listAllSnippets()).toHaveLength(2)
  })

  it("unregisters individual snippets", () => {
    const [snippet] = registerSnippetFile(
      "p",
      "js",
      JSON.stringify({ Hello: { prefix: "h", body: "h" } })
    )
    expect(snippet).toBeDefined()
    unregisterSnippet(snippet!.id)
    expect(listAllSnippets()).toEqual([])
    // Idempotent
    expect(() => unregisterSnippet(snippet!.id)).not.toThrow()
  })

  it("bulk-unregisters by plugin id", () => {
    registerSnippetFile("p1", "js", JSON.stringify({ A: { prefix: "a", body: "a" } }))
    registerSnippetFile("p1", "py", JSON.stringify({ B: { prefix: "b", body: "b" } }))
    registerSnippetFile("p2", "js", JSON.stringify({ C: { prefix: "c", body: "c" } }))
    const removed = unregisterSnippetsByPlugin("p1")
    expect(removed).toBe(2)
    expect(listAllSnippets().map((s) => s.name)).toEqual(["C"])
  })

  it("emits register / unregister events to subscribers", async () => {
    const events: string[] = []
    const dispose = subscribeSnippets((e) => {
      events.push(`${e.type}:${e.contribution.name}`)
    })
    const [snippet] = registerSnippetFile(
      "p",
      "js",
      JSON.stringify({ X: { prefix: "x", body: "x" } })
    )
    unregisterSnippet(snippet!.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(events).toEqual(["register:X", "unregister:X"])
    dispose()
  })

  it("survives a listener that throws", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      subscribeSnippets(() => {
        throw new Error("boom")
      })
      registerSnippetFile("p", "js", JSON.stringify({ A: { prefix: "a", body: "a" } }))
      await new Promise((r) => setTimeout(r, 0))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// ── W5.1: enable-time manifest registration ──────────────────────────────────
jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileOps = require("@/lib/file/file-operations") as { readTextFile: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerSnippetsForPlugin } = require("./snippets-bridge") as {
  registerSnippetsForPlugin: (
    pluginId: string,
    entries: Array<{ language: string; path: string }>,
    baseDir: string
  ) => Promise<{ registered: number; errors: string[] }>
}

describe("registerSnippetsForPlugin (W5.1)", () => {
  beforeEach(() => {
    __resetSnippetsForTesting()
    fileOps.readTextFile.mockReset()
  })

  it("registers every snippet from the contributed file", async () => {
    fileOps.readTextFile.mockResolvedValue(
      JSON.stringify({
        log: { prefix: "log", body: "console.log($1)" },
        warn: { prefix: ["warn"], body: ["console.warn($1)"] },
      })
    )
    const result = await registerSnippetsForPlugin(
      "p1",
      [{ language: "typescript", path: "snippets/ts.json" }],
      "/plugins/p1"
    )
    expect(result).toEqual({ registered: 2, errors: [] })
    expect(listSnippetsForLanguage("typescript")).toHaveLength(2)
  })

  it("rejects traversal paths", async () => {
    const result = await registerSnippetsForPlugin(
      "p1",
      [{ language: "ts", path: "/etc/passwd" }],
      "/plugins/p1"
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0]).toMatch(/unsafe snippet path/)
  })
})
