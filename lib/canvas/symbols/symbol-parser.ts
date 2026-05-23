/**
 * Symbol Parser - Parse and navigate code symbols in Canvas documents.
 *
 * Type definitions live in `@/types/canvas/symbols` (and `LineRange` in
 * `@/types/canvas/collaboration`). They are re-exported here so existing
 * imports of `import { DocumentSymbol } from '@/lib/canvas/symbols/symbol-parser'`
 * keep working without changes.
 */

import { loggers } from "@/lib/logging"
import type { DocumentSymbol, SymbolKind, SymbolLocation } from "@/types/canvas/symbols"
import type { LineRange } from "@/types/canvas/collaboration"

export type { DocumentSymbol, SymbolKind, SymbolLocation, LineRange }

const SYMBOL_ICON_MAP: Record<SymbolKind, string> = {
  file: "📄",
  module: "📦",
  namespace: "📁",
  package: "📦",
  class: "🔷",
  method: "🔹",
  property: "🔸",
  field: "🔸",
  constructor: "🔨",
  enum: "📋",
  interface: "🔶",
  function: "🔹",
  variable: "📎",
  constant: "🔒",
  string: "📝",
  number: "#️⃣",
  boolean: "✅",
  array: "📚",
  object: "📦",
  key: "🔑",
  null: "⬜",
  enumMember: "📍",
  struct: "🏗️",
  event: "⚡",
  operator: "➕",
  typeParameter: "🔤",
}

export class SymbolParser {
  private languagePatterns: Record<string, SymbolPattern[]> = {
    javascript: this.getJavaScriptPatterns(),
    typescript: this.getTypeScriptPatterns(),
    python: this.getPythonPatterns(),
  }

  parseSymbols(content: string, language: string): DocumentSymbol[] {
    const patterns = this.languagePatterns[language] || this.languagePatterns["javascript"]
    const symbols: DocumentSymbol[] = []
    const lines = content.split("\n")

    try {
      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0
        let match

        while ((match = pattern.regex.exec(content)) !== null) {
          const startLine = this.getLineNumber(content, match.index)
          const endLine = this.findBlockEnd(lines, startLine - 1, pattern.kind)

          const symbol: DocumentSymbol = {
            name: match[1],
            kind: pattern.kind,
            range: {
              startLine,
              startColumn: 1,
              endLine: endLine + 1,
              endColumn: (lines[endLine] || "").length + 1,
            },
            selectionRange: {
              startLine,
              startColumn: match.index - content.lastIndexOf("\n", match.index),
              endLine: startLine,
              endColumn: match.index - content.lastIndexOf("\n", match.index) + match[0].length,
            },
            detail: pattern.getDetail?.(match),
          }

          if (pattern.hasChildren) {
            const blockContent = lines.slice(startLine, endLine + 1).join("\n")
            symbol.children = this.parseChildSymbols(blockContent, language, startLine)
          }

          symbols.push(symbol)
        }
      }
    } catch (err) {
      loggers.canvas.warn("symbol-parser parseSymbols failed", {
        language,
        error: String(err),
      })
    }

    return this.sortAndNestSymbols(symbols)
  }

  private parseChildSymbols(
    content: string,
    language: string,
    lineOffset: number
  ): DocumentSymbol[] {
    const childPatterns = this.getChildPatterns(language)
    const symbols: DocumentSymbol[] = []
    const lines = content.split("\n")

    for (const pattern of childPatterns) {
      pattern.regex.lastIndex = 0
      let match

      while ((match = pattern.regex.exec(content)) !== null) {
        const localLine = this.getLineNumber(content, match.index)
        const startLine = localLine + lineOffset - 1
        const localEndLine = pattern.hasChildren
          ? this.findBlockEnd(lines, localLine - 1, pattern.kind)
          : localLine - 1
        const endLine = localEndLine + lineOffset - 1

        symbols.push({
          name: match[1],
          kind: pattern.kind,
          range: {
            startLine,
            startColumn: 1,
            endLine,
            endColumn: (lines[localEndLine] || "").length + 1,
          },
          selectionRange: {
            startLine,
            startColumn: 1,
            endLine: startLine,
            endColumn: match[0].length,
          },
        })
      }
    }

    return symbols
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split("\n").length
  }

  private findBlockEnd(lines: string[], startLine: number, kind: SymbolKind): number {
    let braceCount = 0
    let foundStart = false

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i]
      for (const char of line) {
        if (char === "{") {
          braceCount++
          foundStart = true
        } else if (char === "}") {
          braceCount--
          if (foundStart && braceCount === 0) {
            return i
          }
        }
      }
    }

    if (kind === "variable" || kind === "constant") {
      return startLine
    }

    return Math.min(startLine + 20, lines.length - 1)
  }

  private sortAndNestSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
    return symbols.sort((a, b) => a.range.startLine - b.range.startLine)
  }

  findSymbolByName(name: string, symbols: DocumentSymbol[]): DocumentSymbol | null {
    for (const symbol of symbols) {
      if (symbol.name === name) return symbol
      if (symbol.children) {
        const found = this.findSymbolByName(name, symbol.children)
        if (found) return found
      }
    }
    return null
  }

  findSymbolAtLine(line: number, symbols: DocumentSymbol[]): DocumentSymbol | null {
    for (const symbol of symbols) {
      if (line >= symbol.range.startLine && line <= symbol.range.endLine) {
        if (symbol.children) {
          const child = this.findSymbolAtLine(line, symbol.children)
          if (child) return child
        }
        return symbol
      }
    }
    return null
  }

  getSymbolsInRange(range: LineRange, symbols: DocumentSymbol[]): DocumentSymbol[] {
    const result: DocumentSymbol[] = []

    for (const symbol of symbols) {
      if (symbol.range.startLine <= range.endLine && symbol.range.endLine >= range.startLine) {
        result.push(symbol)
      }
      if (symbol.children) {
        result.push(...this.getSymbolsInRange(range, symbol.children))
      }
    }

    return result
  }

  getSymbolLocation(line: number, symbols: DocumentSymbol[]): SymbolLocation | null {
    const chain: DocumentSymbol[] = []

    const findLocation = (syms: DocumentSymbol[]): boolean => {
      for (const symbol of syms) {
        if (line >= symbol.range.startLine && line <= symbol.range.endLine) {
          chain.push(symbol)
          if (symbol.children && findLocation(symbol.children)) {
            return true
          }
          return true
        }
      }

      return false
    }

    if (!findLocation(symbols) || chain.length === 0) {
      return null
    }

    return {
      symbol: chain[chain.length - 1],
      path: chain.map((symbol) => symbol.name),
      chain,
    }
  }

  getSymbolBreadcrumb(line: number, symbols: DocumentSymbol[]): string[] {
    return this.getSymbolLocation(line, symbols)?.path || []
  }

  getSymbolIcon(kind: SymbolKind): string {
    return SYMBOL_ICON_MAP[kind] || "📎"
  }

  private getJavaScriptPatterns(): SymbolPattern[] {
    return [
      {
        regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
        kind: "function",
        hasChildren: true,
      },
      {
        regex: /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,
        kind: "function",
        hasChildren: true,
      },
      { regex: /(?:export\s+)?class\s+(\w+)/g, kind: "class", hasChildren: true },
      { regex: /export\s+default\s+class\s+(\w+)/g, kind: "class", hasChildren: true },
      { regex: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g, kind: "function" },
      { regex: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/g, kind: "function" },
      { regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g, kind: "variable" },
    ]
  }

  private getTypeScriptPatterns(): SymbolPattern[] {
    return [
      ...this.getJavaScriptPatterns(),
      { regex: /(?:export\s+)?interface\s+(\w+)/g, kind: "interface", hasChildren: true },
      { regex: /(?:export\s+)?type\s+(\w+)\s*=/g, kind: "typeParameter" },
      { regex: /(?:export\s+)?enum\s+(\w+)/g, kind: "enum", hasChildren: true },
      { regex: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g, kind: "class", hasChildren: true },
    ]
  }

  private getPythonPatterns(): SymbolPattern[] {
    return [
      {
        regex: /^(?:@\w+(?:\([^)]*\))?[\s\S]*?)?(?:async\s+)?def\s+(\w+)/gm,
        kind: "function",
        hasChildren: true,
      },
      {
        regex: /^(?:@\w+(?:\([^)]*\))?[\s\S]*?)?class\s+(\w+)/gm,
        kind: "class",
        hasChildren: true,
      },
      { regex: /^(\w+)\s*=/gm, kind: "variable" },
    ]
  }

  private getChildPatterns(language: string): SymbolPattern[] {
    if (language === "python") {
      return [{ regex: /^\s+def\s+(\w+)/gm, kind: "method", hasChildren: true }]
    }
    return [
      { regex: /(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/g, kind: "method", hasChildren: true },
      { regex: /(?:get|set)\s+(\w+)\s*\(/g, kind: "property" },
      { regex: /(\w+)\s*:\s*\w+/g, kind: "property" },
    ]
  }
}

interface SymbolPattern {
  regex: RegExp
  kind: SymbolKind
  hasChildren?: boolean
  getDetail?: (match: RegExpExecArray) => string
}

export const symbolParser = new SymbolParser()

export default SymbolParser
