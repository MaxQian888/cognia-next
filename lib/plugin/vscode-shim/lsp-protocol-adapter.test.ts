import {
  vscodePositionToMonaco,
  monacoPositionToVscode,
  vscodeRangeToMonaco,
  monacoRangeToVscode,
  vscodeCompletionKindToMonaco,
  vscodeCompletionItemToMonaco,
  vscodeCompletionResultToMonaco,
  vscodeDiagnosticSeverityToMonaco,
  lspDiagnosticSeverityToMonaco,
  vscodeDiagnosticToMonacoMarker,
  lspDiagnosticToMonacoMarker,
  vscodeHoverToMonaco,
  vscodeLocationToMonaco,
  vscodeLocationsToMonaco,
  vscodeTextEditToMonaco,
  vscodeTextEditsToMonaco,
  vscodeWorkspaceEditToMonaco,
  vscodeSignatureHelpToMonaco,
  vscodeCodeLensToMonaco,
  vscodeDocumentSymbolToMonaco,
  vscodeInlayHintToMonaco,
  vscodeFoldingRangeToMonaco,
  vscodeSelectionRangeToMonaco,
  vscodeDocumentLinkToMonaco,
  vscodeColorInformationToMonaco,
  vscodeSemanticTokensToMonaco,
  lspPublishDiagnosticsToBridgePayload,
  type VscodePosition,
  type VscodeRange,
} from "./lsp-protocol-adapter"

describe("lsp-protocol-adapter", () => {
  describe("Position", () => {
    it("VS Code 0-based → Monaco 1-based", () => {
      expect(vscodePositionToMonaco({ line: 0, character: 0 })).toEqual({
        lineNumber: 1,
        column: 1,
      })
      expect(vscodePositionToMonaco({ line: 5, character: 12 })).toEqual({
        lineNumber: 6,
        column: 13,
      })
    })

    it("Monaco 1-based → VS Code 0-based", () => {
      expect(monacoPositionToVscode({ lineNumber: 1, column: 1 })).toEqual({
        line: 0,
        character: 0,
      })
      expect(monacoPositionToVscode({ lineNumber: 6, column: 13 })).toEqual({
        line: 5,
        character: 12,
      })
    })

    it("Position round-trips", () => {
      const cases: VscodePosition[] = [
        { line: 0, character: 0 },
        { line: 17, character: 4 },
        { line: 100, character: 999 },
      ]
      for (const p of cases) {
        expect(monacoPositionToVscode(vscodePositionToMonaco(p))).toEqual(p)
      }
    })
  })

  describe("Range", () => {
    it("VS Code Range → Monaco Range (1-based)", () => {
      expect(
        vscodeRangeToMonaco({ start: { line: 0, character: 0 }, end: { line: 2, character: 5 } })
      ).toEqual({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 3,
        endColumn: 6,
      })
    })

    it("Monaco Range → VS Code Range round-trip", () => {
      const cases: VscodeRange[] = [
        { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        { start: { line: 4, character: 2 }, end: { line: 5, character: 0 } },
      ]
      for (const r of cases) {
        expect(monacoRangeToVscode(vscodeRangeToMonaco(r))).toEqual(r)
      }
    })

    it("preserves multi-line ranges", () => {
      const r = vscodeRangeToMonaco({
        start: { line: 1, character: 2 },
        end: { line: 5, character: 0 },
      })
      expect(r.startLineNumber).toBe(2)
      expect(r.endLineNumber).toBe(6)
      expect(r.startColumn).toBe(3)
      expect(r.endColumn).toBe(1)
    })
  })

  describe("CompletionItemKind", () => {
    it("maps VS Code Function (3) → Monaco Function (1)", () => {
      expect(vscodeCompletionKindToMonaco(3)).toBe(1)
    })

    it("maps VS Code Method (2) → Monaco Method (0)", () => {
      expect(vscodeCompletionKindToMonaco(2)).toBe(0)
    })

    it("maps VS Code Snippet (15) → Monaco Snippet (27)", () => {
      expect(vscodeCompletionKindToMonaco(15)).toBe(27)
    })

    it("maps VS Code TypeParameter (25) → Monaco TypeParameter (24)", () => {
      expect(vscodeCompletionKindToMonaco(25)).toBe(24)
    })

    it("falls back to Text (18) on undefined", () => {
      expect(vscodeCompletionKindToMonaco(undefined)).toBe(18)
    })

    it("falls back to Text (18) on out-of-range", () => {
      expect(vscodeCompletionKindToMonaco(999)).toBe(18)
      expect(vscodeCompletionKindToMonaco(0)).toBe(18)
    })

    it("covers all 25 enum entries", () => {
      const expected = [
        18, 0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 15, 17, 27, 19, 20, 21, 23, 16, 14, 6, 10, 11, 24,
      ]
      for (let i = 1; i <= 25; i++) {
        expect(vscodeCompletionKindToMonaco(i)).toBe(expected[i - 1])
      }
    })
  })

  describe("CompletionItem", () => {
    it("converts a plain completion item", () => {
      const out = vscodeCompletionItemToMonaco({
        label: "foo",
        kind: 3, // Function
        detail: "(...) => void",
        insertText: "foo()",
      })
      expect(out).toMatchObject({
        label: "foo",
        kind: 1, // Monaco Function
        detail: "(...) => void",
        insertText: "foo()",
      })
      expect(out.insertTextRules).toBeUndefined()
    })

    it("extracts label.label from CompletionItemLabel object", () => {
      const out = vscodeCompletionItemToMonaco({
        label: { label: "render", detail: "React" },
        kind: 3,
      })
      expect(out.label).toBe("render")
    })

    it("emits InsertAsSnippet (4) when insertTextFormat is Snippet (2)", () => {
      const out = vscodeCompletionItemToMonaco({
        label: "for-loop",
        insertText: "for (let ${1:i} = 0; ${1:i} < ${2:N}; ${1:i}++) { $0 }",
        insertTextFormat: 2,
      })
      expect(out.insertTextRules).toBe(4)
    })

    it("flattens MarkupContent documentation to its value string", () => {
      const out = vscodeCompletionItemToMonaco({
        label: "x",
        documentation: { kind: "markdown", value: "**bold**" },
      })
      expect(out.documentation).toBe("**bold**")
    })

    it("converts inserting/replacing range to Monaco range (picks replacing)", () => {
      const out = vscodeCompletionItemToMonaco({
        label: "x",
        range: {
          inserting: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          replacing: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      })
      expect(out.range).toEqual({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 6, // 5 + 1 (from replacing)
      })
    })

    it("falls back to label as insertText when insertText is omitted", () => {
      const out = vscodeCompletionItemToMonaco({ label: "abc" })
      expect(out.insertText).toBe("abc")
    })
  })

  describe("CompletionResult", () => {
    it("handles a flat array result", () => {
      const out = vscodeCompletionResultToMonaco([{ label: "a", kind: 3 }, { label: "b" }])
      expect(out?.suggestions).toHaveLength(2)
      expect(out?.suggestions[0].label).toBe("a")
    })

    it("handles a CompletionList result", () => {
      const out = vscodeCompletionResultToMonaco({
        isIncomplete: false,
        items: [{ label: "x", kind: 6 }],
      })
      expect(out?.suggestions).toHaveLength(1)
    })

    it("returns null on null/undefined", () => {
      expect(vscodeCompletionResultToMonaco(null)).toBeNull()
      expect(vscodeCompletionResultToMonaco(undefined)).toBeNull()
    })
  })

  describe("DiagnosticSeverity", () => {
    it("VS Code: 0 → error, 1 → warning, 2 → info, 3 → hint", () => {
      expect(vscodeDiagnosticSeverityToMonaco(0)).toBe("error")
      expect(vscodeDiagnosticSeverityToMonaco(1)).toBe("warning")
      expect(vscodeDiagnosticSeverityToMonaco(2)).toBe("info")
      expect(vscodeDiagnosticSeverityToMonaco(3)).toBe("hint")
    })

    it("LSP: 1 → error, 2 → warning, 3 → info, 4 → hint (off-by-one from VS Code)", () => {
      expect(lspDiagnosticSeverityToMonaco(1)).toBe("error")
      expect(lspDiagnosticSeverityToMonaco(2)).toBe("warning")
      expect(lspDiagnosticSeverityToMonaco(3)).toBe("info")
      expect(lspDiagnosticSeverityToMonaco(4)).toBe("hint")
    })

    it("undefined defaults to error in both flavours", () => {
      expect(vscodeDiagnosticSeverityToMonaco(undefined)).toBe("error")
      expect(lspDiagnosticSeverityToMonaco(undefined)).toBe("error")
    })

    it("out-of-range falls back to error", () => {
      expect(vscodeDiagnosticSeverityToMonaco(99)).toBe("error")
      expect(lspDiagnosticSeverityToMonaco(0)).toBe("error")
      expect(lspDiagnosticSeverityToMonaco(5)).toBe("error")
    })
  })

  describe("Diagnostic", () => {
    it("converts VS Code Diagnostic → MonacoMarker", () => {
      const out = vscodeDiagnosticToMonacoMarker({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 0,
        message: "boom",
        source: "eslint",
      })
      expect(out).toEqual({
        severity: "error",
        message: "boom",
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
        source: "eslint",
      })
    })

    it("converts LSP Diagnostic → MonacoMarker (1-indexed severity)", () => {
      const out = lspDiagnosticToMonacoMarker({
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } },
        severity: 2,
        message: "unused",
      })
      expect(out.severity).toBe("warning")
      expect(out.range.startLineNumber).toBe(3)
    })
  })

  describe("Hover", () => {
    it("handles a single string", () => {
      expect(vscodeHoverToMonaco({ contents: "plain text" })).toEqual({
        contents: ["plain text"],
        range: undefined,
      })
    })

    it("handles a MarkupContent (markdown)", () => {
      expect(vscodeHoverToMonaco({ contents: { kind: "markdown", value: "**bold**" } })).toEqual({
        contents: ["**bold**"],
        range: undefined,
      })
    })

    it("handles a fenced MarkedString", () => {
      const out = vscodeHoverToMonaco({
        contents: { language: "typescript", value: "const x: number" },
      })
      expect(out.contents[0]).toBe("```typescript\nconst x: number\n```")
    })

    it("handles a mixed array of all three forms", () => {
      const out = vscodeHoverToMonaco({
        contents: [
          "header line",
          { kind: "markdown", value: "**body**" },
          { language: "ts", value: "let y" },
        ],
      })
      expect(out.contents).toEqual(["header line", "**body**", "```ts\nlet y\n```"])
    })

    it("includes a converted range when provided", () => {
      const out = vscodeHoverToMonaco({
        contents: "x",
        range: { start: { line: 1, character: 1 }, end: { line: 1, character: 4 } },
      })
      expect(out.range).toEqual({
        startLineNumber: 2,
        startColumn: 2,
        endLineNumber: 2,
        endColumn: 5,
      })
    })
  })

  describe("Location & TextEdit", () => {
    it("converts Location", () => {
      expect(
        vscodeLocationToMonaco({
          uri: "file:///a.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        })
      ).toEqual({
        uri: "file:///a.ts",
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
      })
    })

    it("converts Locations[]", () => {
      const out = vscodeLocationsToMonaco([
        {
          uri: "file:///a.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        {
          uri: "file:///b.ts",
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
        },
      ])
      expect(out).toHaveLength(2)
      expect(out[1].uri).toBe("file:///b.ts")
    })

    it("converts TextEdit", () => {
      expect(
        vscodeTextEditToMonaco({
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "X",
        })
      ).toEqual({
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
        text: "X",
      })
    })

    it("converts TextEdit[]", () => {
      expect(vscodeTextEditsToMonaco([])).toEqual([])
    })
  })

  describe("WorkspaceEdit", () => {
    it("flattens changes map", () => {
      const out = vscodeWorkspaceEditToMonaco({
        changes: {
          "file:///a.ts": [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "A",
            },
          ],
          "file:///b.ts": [
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
              newText: "B",
            },
          ],
        },
      })
      expect(out.edits).toHaveLength(2)
      expect(out.edits.map((e) => e.resource).sort()).toEqual(["file:///a.ts", "file:///b.ts"])
    })

    it("flattens documentChanges", () => {
      const out = vscodeWorkspaceEditToMonaco({
        documentChanges: [
          {
            textDocument: { uri: "file:///x.ts", version: 1 },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "// hi\n",
              },
            ],
          },
        ],
      })
      expect(out.edits[0].resource).toBe("file:///x.ts")
      expect(out.edits[0].edits[0].text).toBe("// hi\n")
    })

    it("handles empty workspace edit", () => {
      expect(vscodeWorkspaceEditToMonaco({})).toEqual({ edits: [] })
    })
  })

  describe("SignatureHelp", () => {
    it("converts and supplies defaults for activeSignature/activeParameter", () => {
      const out = vscodeSignatureHelpToMonaco({
        signatures: [
          {
            label: "foo(x: number)",
            documentation: { kind: "markdown", value: "the foo" },
          },
        ],
      })
      expect(out.signatures[0].label).toBe("foo(x: number)")
      expect(out.signatures[0].documentation).toBe("the foo")
      expect(out.activeSignature).toBe(0)
      expect(out.activeParameter).toBe(0)
    })

    it("preserves provided activeSignature/activeParameter", () => {
      const out = vscodeSignatureHelpToMonaco({
        signatures: [{ label: "a" }],
        activeSignature: 7,
        activeParameter: 3,
      })
      expect(out.activeSignature).toBe(7)
      expect(out.activeParameter).toBe(3)
    })
  })

  describe("CodeLens", () => {
    it("converts CodeLens with command", () => {
      const out = vscodeCodeLensToMonaco({
        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
        command: { title: "Run", command: "myExt.run", arguments: ["arg1"] },
      })
      expect(out.range.startLineNumber).toBe(6)
      expect(out.command).toEqual({ id: "myExt.run", title: "Run", arguments: ["arg1"] })
    })

    it("handles missing command", () => {
      const out = vscodeCodeLensToMonaco({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      })
      expect(out.command).toBeUndefined()
    })
  })

  describe("DocumentSymbol", () => {
    it("converts a flat symbol", () => {
      const out = vscodeDocumentSymbolToMonaco({
        name: "MyClass",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
      })
      expect(out.name).toBe("MyClass")
      expect(out.detail).toBe("")
      expect(out.range.endLineNumber).toBe(11)
    })

    it("recursively converts children", () => {
      const out = vscodeDocumentSymbolToMonaco({
        name: "outer",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        children: [
          {
            name: "inner",
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 2, character: 0 } },
            selectionRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } },
          },
        ],
      })
      expect(out.children?.[0].name).toBe("inner")
      expect(out.children?.[0].range.startLineNumber).toBe(2)
    })
  })

  describe("InlayHint", () => {
    it("converts a type hint", () => {
      const out = vscodeInlayHintToMonaco({
        position: { line: 0, character: 4 },
        label: ": number",
        kind: 1,
      })
      expect(out).toEqual({
        position: { lineNumber: 1, column: 5 },
        label: ": number",
        kind: "type",
      })
    })

    it("flattens label parts to a single string", () => {
      const out = vscodeInlayHintToMonaco({
        position: { line: 0, character: 0 },
        label: [{ value: "first" }, { value: "-" }, { value: "last" }],
        kind: 2,
      })
      expect(out.label).toBe("first-last")
      expect(out.kind).toBe("parameter")
    })

    it("undefined kind becomes undefined (Monaco shows default)", () => {
      const out = vscodeInlayHintToMonaco({
        position: { line: 0, character: 0 },
        label: "x",
      })
      expect(out.kind).toBeUndefined()
    })
  })

  describe("FoldingRange", () => {
    it("converts LSP folding (0-based) to Monaco (1-based) lines", () => {
      const out = vscodeFoldingRangeToMonaco({ startLine: 3, endLine: 8, kind: "comment" })
      expect(out.start).toBe(4)
      expect(out.end).toBe(9)
      expect(out.kind).toBe("comment")
    })
  })

  describe("SelectionRange", () => {
    it("recursively converts parents", () => {
      const out = vscodeSelectionRangeToMonaco({
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
        parent: {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
        },
      })
      expect(out.range.startColumn).toBe(2)
      expect(out.parent?.range.startColumn).toBe(1)
      expect(out.parent?.range.endColumn).toBe(11)
    })

    it("handles a leaf with no parent", () => {
      const out = vscodeSelectionRangeToMonaco({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      })
      expect(out.parent).toBeUndefined()
    })
  })

  describe("DocumentLink", () => {
    it("converts target to url and preserves tooltip", () => {
      const out = vscodeDocumentLinkToMonaco({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        target: "https://example.com",
        tooltip: "Open docs",
      })
      expect(out.url).toBe("https://example.com")
      expect(out.tooltip).toBe("Open docs")
      expect(out.range.endColumn).toBe(21)
    })
  })

  describe("ColorInformation", () => {
    it("converts range and preserves color values", () => {
      const out = vscodeColorInformationToMonaco({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        color: { red: 1, green: 0.5, blue: 0, alpha: 0.8 },
      })
      expect(out.color).toEqual({ red: 1, green: 0.5, blue: 0, alpha: 0.8 })
      expect(out.range.endColumn).toBe(8)
    })
  })

  describe("SemanticTokens", () => {
    it("passes through data + resultId", () => {
      const out = vscodeSemanticTokensToMonaco({
        data: [0, 0, 5, 0, 0, 0, 6, 4, 1, 0],
        resultId: "r1",
      })
      expect(out.data).toHaveLength(10)
      expect(out.resultId).toBe("r1")
    })

    it("handles missing resultId", () => {
      const out = vscodeSemanticTokensToMonaco({ data: [] })
      expect(out.resultId).toBeUndefined()
    })
  })

  describe("LSP PublishDiagnostics → bridge payload", () => {
    it("maps every diagnostic through lspDiagnosticToMonacoMarker", () => {
      const out = lspPublishDiagnosticsToBridgePayload({
        uri: "file:///foo.rs",
        diagnostics: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
            severity: 1,
            message: "type error",
            source: "rust-analyzer",
          },
          {
            range: { start: { line: 5, character: 4 }, end: { line: 5, character: 10 } },
            severity: 2,
            message: "unused",
          },
        ],
      })
      expect(out.uri).toBe("file:///foo.rs")
      expect(out.markers).toHaveLength(2)
      expect(out.markers[0].severity).toBe("error")
      expect(out.markers[1].severity).toBe("warning")
      expect(out.markers[0].range.startLineNumber).toBe(2)
    })

    it("returns empty markers for empty diagnostics", () => {
      const out = lspPublishDiagnosticsToBridgePayload({
        uri: "file:///foo.rs",
        diagnostics: [],
      })
      expect(out.markers).toEqual([])
    })
  })
})
