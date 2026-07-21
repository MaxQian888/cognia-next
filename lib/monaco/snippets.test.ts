import { collectEditorSnippets, registerAllSnippets, registerEmmetSupport } from "./snippets"
import { snippetProvider } from "@/lib/canvas/snippets/snippet-registry"
import { listSnippetsForLanguage } from "@/lib/plugin/bridge/snippets-bridge"
import { isTauri } from "@/lib/tauri"

jest.mock("@/lib/plugin/bridge/snippets-bridge", () => ({
  listSnippetsForLanguage: jest.fn(() => []),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

const disposeHtml = jest.fn()
const disposeCss = jest.fn()
const disposeJsx = jest.fn()
const emmetHTML = jest.fn(() => disposeHtml)
const emmetCSS = jest.fn(() => disposeCss)
const emmetJSX = jest.fn(() => disposeJsx)
jest.mock("emmet-monaco-es", () => ({ emmetHTML, emmetCSS, emmetJSX }))

const mockedListSnippets = listSnippetsForLanguage as jest.MockedFunction<
  typeof listSnippetsForLanguage
>
const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

interface Suggestion {
  label: string
  kind: number
  insertText: string
  insertTextRules: number
  detail?: string
  documentation?: string
}

function makeFakeMonaco() {
  const providers: Array<{ selector: string | string[]; provider: unknown }> = []
  const monaco = {
    languages: {
      getLanguages: () => [{ id: "javascript" }, { id: "typescript" }],
      registerCompletionItemProvider: jest.fn((selector, provider) => {
        providers.push({ selector, provider })
        return { dispose: jest.fn() }
      }),
      CompletionItemKind: { Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
  }
  return { monaco, providers }
}

function makeModel(language: string) {
  return {
    getLanguageId: () => language,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 3 }),
  }
}

beforeEach(() => {
  mockedListSnippets.mockReturnValue([])
  mockedIsTauri.mockReturnValue(false)
})

describe("collectEditorSnippets", () => {
  it("normalizes builtin and multi-prefix plugin snippets for every editor engine", () => {
    jest.spyOn(snippetProvider, "getSnippets").mockReturnValue([
      {
        id: "ts-fn",
        prefix: "fn",
        description: "Function",
        body: ["function ${1:name}() {", "  ${0}", "}"],
        language: "typescript",
        category: "functions",
      },
    ])
    mockedListSnippets.mockReturnValue([
      {
        id: "p1:ts:loop",
        pluginId: "p1",
        language: "typescript",
        name: "loop",
        prefix: ["for", "forl"],
        body: "for (const ${1:item} of ${2:items}) { ${0} }",
      },
    ])

    expect(collectEditorSnippets("typescript")).toEqual([
      {
        label: "fn",
        insertText: "function ${1:name}() {\n  ${0}\n}",
        detail: "Function",
        documentation: "functions snippet",
      },
      {
        label: "for",
        insertText: "for (const ${1:item} of ${2:items}) { ${0} }",
        detail: "p1 snippet",
        documentation: "p1 · loop",
      },
      {
        label: "forl",
        insertText: "for (const ${1:item} of ${2:items}) { ${0} }",
        detail: "p1 snippet",
        documentation: "p1 · loop",
      },
    ])
  })

  it("resolves collapsed editor language ids to compatible plugin snippet ids", () => {
    jest.spyOn(snippetProvider, "getSnippets").mockReturnValue([])
    mockedListSnippets.mockImplementation((language) =>
      language === "shellscript"
        ? [
            {
              id: "p1:shellscript:case",
              pluginId: "p1",
              language,
              name: "case",
              prefix: ["case"],
              body: "case ${1:value} in\n  ${0}\nesac",
            },
          ]
        : []
    )

    expect(collectEditorSnippets("shell").map((snippet) => snippet.label)).toContain("case")
    expect(mockedListSnippets).toHaveBeenCalledWith("shellscript")
  })
})

describe("registerAllSnippets", () => {
  it("returns [] when the monaco namespace is missing the register API", () => {
    expect(registerAllSnippets({})).toEqual([])
    expect(registerAllSnippets(null)).toEqual([])
  })

  it("registers one wildcard provider so late-contributed languages are covered", () => {
    const { monaco, providers } = makeFakeMonaco()
    const regs = registerAllSnippets(monaco)
    expect(regs).toHaveLength(1)
    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1)
    expect(providers[0]?.selector).toBe("*")
  })

  it("is idempotent per monaco instance", () => {
    const { monaco } = makeFakeMonaco()
    registerAllSnippets(monaco)
    const second = registerAllSnippets(monaco)
    expect(second).toEqual([])
    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1)
  })

  it("surfaces canvas snippets as snippet completion items", () => {
    const { monaco, providers } = makeFakeMonaco()
    const spy = jest.spyOn(snippetProvider, "getSnippets").mockReturnValue([
      {
        id: "js-fn",
        prefix: "fn",
        description: "Function",
        body: ["function ${1:name}() {", "  ${0}", "}"],
        language: "javascript",
        category: "functions",
      },
    ])
    registerAllSnippets(monaco)
    const provider = providers[0]?.provider as {
      provideCompletionItems(m: unknown, p: unknown): { suggestions: Suggestion[] }
    }
    const { suggestions } = provider.provideCompletionItems(makeModel("javascript"), {
      lineNumber: 1,
      column: 2,
    })
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      label: "fn",
      kind: 27,
      insertText: "function ${1:name}() {\n  ${0}\n}",
      insertTextRules: 4,
      detail: "Function",
    })
    spy.mockRestore()
  })

  it("expands plugin snippets — one item per prefix — read live per request", () => {
    const { monaco, providers } = makeFakeMonaco()
    jest.spyOn(snippetProvider, "getSnippets").mockReturnValue([])
    mockedListSnippets.mockReturnValue([
      {
        id: "p1:ts:forloop",
        pluginId: "p1",
        language: "typescript",
        name: "for loop",
        prefix: ["for", "forl"],
        body: "for (const x of $1) { $0 }",
        description: "for-of",
      },
    ])
    registerAllSnippets(monaco)
    const provider = providers[0]?.provider as {
      provideCompletionItems(m: unknown, p: unknown): { suggestions: Suggestion[] }
    }
    const { suggestions } = provider.provideCompletionItems(makeModel("typescript"), {
      lineNumber: 1,
      column: 2,
    })
    expect(suggestions.map((s) => s.label)).toEqual(["for", "forl"])
    expect(mockedListSnippets).toHaveBeenCalledWith("typescript")
  })
})

describe("registerEmmetSupport", () => {
  it("returns [] and does nothing when not on desktop (Tauri)", () => {
    const { monaco } = makeFakeMonaco()
    expect(registerEmmetSupport(monaco)).toEqual([])
  })

  it("returns [] for a null namespace", () => {
    expect(registerEmmetSupport(null)).toEqual([])
  })

  it("registers once on desktop and returns a disposable", () => {
    mockedIsTauri.mockReturnValue(true)
    const monaco = { languages: {} }
    const regs = registerEmmetSupport(monaco)
    expect(regs).toHaveLength(1)
    expect(typeof regs[0]?.dispose).toBe("function")
    // Idempotent: second call is a no-op.
    expect(registerEmmetSupport(monaco)).toEqual([])
    // Disposing before the async import resolves must not throw.
    expect(() => regs[0]?.dispose()).not.toThrow()
  })

  it("wires html/css/jsx emmet after the async import and tears them down", async () => {
    mockedIsTauri.mockReturnValue(true)
    emmetHTML.mockClear()
    disposeHtml.mockClear()
    const monaco = { languages: {} }
    const regs = registerEmmetSupport(monaco)
    // Flush the dynamic import + its .then().
    await Promise.resolve()
    await Promise.resolve()
    expect(emmetHTML).toHaveBeenCalledWith(monaco, expect.arrayContaining(["html"]))
    expect(emmetCSS).toHaveBeenCalledWith(monaco, expect.arrayContaining(["css"]))
    expect(emmetJSX).toHaveBeenCalledWith(monaco, expect.arrayContaining(["typescriptreact"]))
    regs[0]?.dispose()
    expect(disposeHtml).toHaveBeenCalled()
    expect(disposeCss).toHaveBeenCalled()
    expect(disposeJsx).toHaveBeenCalled()
  })
})
