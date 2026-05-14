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
