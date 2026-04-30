/**
 * Tests for Snippet Registry
 */

import {
  SnippetProvider,
  snippetProvider,
  SNIPPET_REGISTRY,
  type CodeSnippet,
} from "./snippet-registry"

describe("SnippetProvider", () => {
  describe("getSnippets", () => {
    it("should return snippets for JavaScript", () => {
      const snippets = snippetProvider.getSnippets("javascript")

      expect(Array.isArray(snippets)).toBe(true)
      expect(snippets.length).toBeGreaterThan(0)
    })

    it("should return snippets for TypeScript", () => {
      const snippets = snippetProvider.getSnippets("typescript")

      expect(snippets.length).toBeGreaterThan(0)
    })

    it("should return snippets for Python", () => {
      const snippets = snippetProvider.getSnippets("python")

      expect(snippets.length).toBeGreaterThan(0)
    })

    it("should return empty array for unknown language", () => {
      const snippets = snippetProvider.getSnippets("unknown-language")

      expect(snippets.length).toBe(0)
    })
  })

  describe("registerSnippet", () => {
    it("should register a custom snippet", () => {
      const customSnippet: CodeSnippet = {
        id: "custom-test",
        prefix: "customtest",
        description: "A custom test snippet",
        body: 'console.log("custom");',
        language: "javascript",
        category: "custom",
      }

      snippetProvider.registerSnippet(customSnippet)

      const snippets = snippetProvider.getSnippets("javascript")
      const found = snippets.find((s) => s.prefix === "customtest")

      expect(found).toBeDefined()
    })
  })

  describe("searchSnippets", () => {
    it("should find snippets by prefix", () => {
      const results = snippetProvider.searchSnippets("javascript", "fn")

      expect(results.length).toBeGreaterThan(0)
    })

    it("should find snippets by description", () => {
      const results = snippetProvider.searchSnippets("javascript", "function")

      expect(results.length).toBeGreaterThan(0)
    })

    it("should return empty for no matches", () => {
      const results = snippetProvider.searchSnippets("javascript", "xyznonexistent123")

      expect(results.length).toBe(0)
    })
  })

  describe("getSnippetByPrefix", () => {
    it("should get snippet by exact prefix", () => {
      const snippet = snippetProvider.findSnippetByPrefix("javascript", "fn")

      expect(snippet).toBeDefined()
      expect(snippet?.prefix).toBe("fn")
    })

    it("should return undefined for unknown prefix", () => {
      const snippet = snippetProvider.findSnippetByPrefix("javascript", "unknownprefix123")

      expect(snippet).toBeUndefined()
    })
  })

  describe("expandSnippet", () => {
    it("should expand snippet body", () => {
      const snippet: CodeSnippet = {
        id: "test-log",
        prefix: "log",
        description: "Log to console",
        body: "console.log(${1:message});",
        language: "javascript",
        category: "logging",
      }

      const result = snippetProvider.applySnippet(snippet)

      expect(result).toContain("console.log")
    })

    it("should handle snippets with array body", () => {
      const snippet: CodeSnippet = {
        id: "test-func",
        prefix: "func",
        description: "Create function",
        body: ["function ${1:name}(${2:params}) {", "  ${3:body}", "}"],
        language: "javascript",
        category: "functions",
      }

      const result = snippetProvider.applySnippet(snippet)

      expect(result).toContain("function")
    })
  })

  describe("SNIPPET_REGISTRY", () => {
    it("should have built-in snippets for common languages", () => {
      expect(SNIPPET_REGISTRY.javascript).toBeDefined()
      expect(SNIPPET_REGISTRY.typescript).toBeDefined()
      expect(SNIPPET_REGISTRY.python).toBeDefined()
    })
  })

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(snippetProvider).toBeInstanceOf(SnippetProvider)
    })
  })

  describe("uncovered branches", () => {
    it("getSnippetsByCategory filters by category", () => {
      const provider = new SnippetProvider()
      const fnSnippets = provider.getSnippetsByCategory("javascript", "functions")
      expect(Array.isArray(fnSnippets)).toBe(true)
      // every returned snippet must actually have the requested category.
      for (const s of fnSnippets) expect(s.category).toBe("functions")
      // unknown category yields empty array (not undefined).
      expect(provider.getSnippetsByCategory("javascript", "no-such-cat")).toEqual([])
    })

    it("getCategories returns unique non-empty categories", () => {
      const provider = new SnippetProvider()
      const cats = provider.getCategories("javascript")
      expect(cats.length).toBeGreaterThan(0)
      expect(new Set(cats).size).toBe(cats.length)
      for (const c of cats) expect(c).toBeTruthy()
      // unknown language yields no categories.
      expect(provider.getCategories("unknown-lang")).toEqual([])
    })

    it("unregisterSnippet removes a previously-registered snippet", () => {
      const provider = new SnippetProvider()
      const snip: CodeSnippet = {
        id: "tmp",
        prefix: "tmpprefix",
        description: "tmp",
        body: "tmp",
        language: "javascript",
        category: "tmp",
      }
      provider.registerSnippet(snip)
      expect(provider.findSnippetByPrefix("javascript", "tmpprefix")).toBeDefined()
      provider.unregisterSnippet("javascript", "tmp")
      expect(provider.findSnippetByPrefix("javascript", "tmpprefix")).toBeUndefined()
      // unregistering an unknown id is a no-op.
      expect(() => provider.unregisterSnippet("javascript", "no-such-id")).not.toThrow()
    })

    it("export/importCustomSnippets round-trips custom data", () => {
      const provider = new SnippetProvider()
      const snip: CodeSnippet = {
        id: "rt",
        prefix: "rt",
        description: "roundtrip",
        body: "rt",
        language: "javascript",
        category: "rt",
      }
      provider.registerSnippet(snip)
      const json = provider.exportCustomSnippets()
      expect(json).toContain("roundtrip")

      const fresh = new SnippetProvider()
      const ok = fresh.importCustomSnippets(json)
      expect(ok).toBe(true)
      expect(fresh.findSnippetByPrefix("javascript", "rt")).toBeDefined()
    })

    it("exportCustomSnippets handles empty state", () => {
      const fresh = new SnippetProvider()
      const json = fresh.exportCustomSnippets()
      expect(JSON.parse(json)).toEqual({})
    })

    it("importCustomSnippets returns false on invalid JSON", () => {
      const fresh = new SnippetProvider()
      expect(fresh.importCustomSnippets("not json {")).toBe(false)
    })

    it("importCustomSnippets ignores non-array entries", () => {
      const fresh = new SnippetProvider()
      const ok = fresh.importCustomSnippets(JSON.stringify({ js: "oops", good: [] }))
      expect(ok).toBe(true)
      // 'js' was a string, must be ignored — getSnippets falls back to built-in only.
      expect(fresh.getSnippets("js").length).toBe(0)
    })

    it("applySnippet strips multiple placeholder formats", () => {
      const provider = new SnippetProvider()
      // Both ${1:default} and bare $1 placeholders must be stripped.
      const out = provider.applySnippet({
        id: "p",
        prefix: "p",
        description: "p",
        body: "a ${1:foo} b $2 c ${3:baz}",
        language: "javascript",
        category: "p",
      })
      expect(out).toBe("a foo b  c baz")
    })
  })
})
