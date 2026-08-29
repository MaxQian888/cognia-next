/**
 * Context Analyzer - Intelligent code context analysis for better AI suggestions.
 *
 * NOTE: `AiContextSymbol` is intentionally narrower than the full IDE
 * `AiContextSymbol` from `@/types/canvas/symbols`. This shape is the
 * lightweight summary fed into LLM prompts (kind enum + line range only),
 * so we keep it local and don't unify the two.
 */

import { loggers } from "@cognia/logging"
import { symbolParser } from "@/lib/canvas/symbols/symbol-parser"
import type { DocumentSymbol, SymbolKind } from "@/types/canvas/symbols"
import type { CanvasActionType } from "@/lib/ai/generation/canvas-actions"
import type { CursorPosition } from "@/types/canvas/collaboration"

export type { CursorPosition }

export interface AiContextSymbol {
  name: string
  kind:
    | "function"
    | "class"
    | "variable"
    | "import"
    | "type"
    | "interface"
    | "enum"
    | "method"
    | "property"
  range: {
    startLine: number
    endLine: number
  }
  children?: AiContextSymbol[]
}

export interface CodePattern {
  type: string
  name: string
  confidence: number
  range: { startLine: number; endLine: number }
}

export interface DocumentContext {
  language: string
  symbols: AiContextSymbol[]
  imports: string[]
  exports: string[]
  cursorContext: {
    line: number
    column: number
    inFunction: string | null
    inClass: string | null
    inBlock: string | null
    scope: string[]
  }
  patterns: CodePattern[]
  dependencies: string[]
  lineCount: number
  complexity: "low" | "medium" | "high"
}

/**
 * The IDE outline's kind vocabulary is much wider than the prompt summary's.
 * Anything with no sensible narrow equivalent is dropped rather than coerced —
 * a mislabelled symbol in a prompt is worse than a missing one.
 */
const AI_SYMBOL_KIND_BY_OUTLINE_KIND: Partial<Record<SymbolKind, AiContextSymbol["kind"]>> = {
  function: "function",
  constructor: "method",
  method: "method",
  property: "property",
  field: "property",
  class: "class",
  struct: "class",
  interface: "interface",
  enum: "enum",
  enumMember: "property",
  variable: "variable",
  constant: "variable",
  typeParameter: "type",
}

function toAiContextSymbols(symbols: readonly DocumentSymbol[]): AiContextSymbol[] {
  const out: AiContextSymbol[] = []
  for (const symbol of symbols) {
    const kind = AI_SYMBOL_KIND_BY_OUTLINE_KIND[symbol.kind]
    if (!kind) continue
    const children = symbol.children ? toAiContextSymbols(symbol.children) : undefined
    out.push({
      name: symbol.name,
      kind,
      range: { startLine: symbol.range.startLine, endLine: symbol.range.endLine },
      ...(children && children.length > 0 ? { children } : {}),
    })
  }
  return out
}

export class ContextAnalyzer {
  analyzeContext(content: string, position: CursorPosition, language: string): DocumentContext {
    const lines = content.split("\n")
    const symbols = this.parseSymbols(content, language)
    const imports = this.extractImports(content)
    const exports = this.extractExports(content)
    const patterns = this.findPatterns(content, language)
    const cursorContext = this.analyzeCursorContext(lines, position, symbols)
    const dependencies = this.extractDependencies(imports)
    const complexity = this.assessComplexity(content, symbols)

    return {
      language,
      symbols,
      imports,
      exports,
      cursorContext,
      patterns,
      dependencies,
      lineCount: lines.length,
      complexity,
    }
  }

  /**
   * Delegates to the outline parser rather than carrying a second regex table.
   * `symbol-parser.ts` is the one the Canvas outline panel already renders, so
   * a symbol the reader can see in the outline is the same symbol the model is
   * told about. The two tables had drifted (this one had no Python support and
   * no nesting); keeping both meant every language fix had to land twice.
   */
  parseSymbols(content: string, language: string): AiContextSymbol[] {
    if (!content) return []
    return toAiContextSymbols(symbolParser.parseSymbols(content, language)).sort(
      (a, b) => a.range.startLine - b.range.startLine
    )
  }

  extractImports(content: string): string[] {
    const imports: string[] = []
    const pattern = /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g

    let match
    while ((match = pattern.exec(content)) !== null) {
      imports.push(match[1])
    }

    return imports
  }

  extractExports(content: string): string[] {
    const exports: string[] = []
    const patterns = [
      /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
      /export\s+\{\s*([^}]+)\s*\}/g,
    ]

    for (const pattern of patterns) {
      let match
      while ((match = pattern.exec(content)) !== null) {
        const items = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0])
        exports.push(...items)
      }
    }

    return [...new Set(exports)]
  }

  private analyzeCursorContext(
    lines: string[],
    position: CursorPosition,
    symbols: AiContextSymbol[]
  ): DocumentContext["cursorContext"] {
    const { line, column } = position
    const scope: string[] = []
    let inFunction: string | null = null
    let inClass: string | null = null
    let inBlock: string | null = null

    for (const symbol of symbols) {
      if (line >= symbol.range.startLine && line <= symbol.range.endLine) {
        scope.push(symbol.name)

        if (symbol.kind === "function" || symbol.kind === "method") {
          inFunction = symbol.name
        } else if (symbol.kind === "class") {
          inClass = symbol.name
        }
      }
    }

    const currentLine = lines[line - 1] || ""
    if (
      currentLine.includes("if") ||
      currentLine.includes("for") ||
      currentLine.includes("while")
    ) {
      inBlock = "control"
    } else if (currentLine.includes("try") || currentLine.includes("catch")) {
      inBlock = "error-handling"
    }

    return { line, column, inFunction, inClass, inBlock, scope }
  }

  findPatterns(content: string, _language: string): CodePattern[] {
    const patterns: CodePattern[] = []

    const patternMatchers: { type: string; regex: RegExp; confidence: number }[] = [
      {
        type: "react-component",
        regex:
          /export\s+(?:default\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{[\s\S]*?return\s*\(/m,
        confidence: 0.9,
      },
      {
        type: "react-hook",
        regex: /(?:const|let)\s+\[\w+,\s*set\w+\]\s*=\s*useState/g,
        confidence: 0.95,
      },
      { type: "async-await", regex: /async\s+(?:function|\w+\s*=\s*async)/g, confidence: 0.9 },
      { type: "try-catch", regex: /try\s*\{[\s\S]*?\}\s*catch/g, confidence: 0.95 },
      { type: "class-based", regex: /class\s+\w+(?:\s+extends\s+\w+)?/g, confidence: 0.9 },
      { type: "module-export", regex: /export\s+(?:default|{)/g, confidence: 0.85 },
      { type: "destructuring", regex: /(?:const|let|var)\s*\{[^}]+\}\s*=/g, confidence: 0.8 },
    ]

    for (const matcher of patternMatchers) {
      matcher.regex.lastIndex = 0
      let match
      while ((match = matcher.regex.exec(content)) !== null) {
        const lineNumber = content.substring(0, match.index).split("\n").length
        patterns.push({
          type: matcher.type,
          name: matcher.type,
          confidence: matcher.confidence,
          range: { startLine: lineNumber, endLine: lineNumber },
        })
      }
    }

    return patterns
  }

  private extractDependencies(imports: string[]): string[] {
    return (
      imports
        .filter((imp) => !imp.startsWith(".") && !imp.startsWith("@/"))
        // Strip only a LEADING `@` — the npm scope marker. `replace("@", "")`
        // removed the first `@` anywhere in the specifier, which quietly turned
        // `jane@example.com/pkg` into `janeexample.com`: an email that no longer
        // matches the PII gate's pattern. Derived text must never reshape its
        // source, because `hasNoLeakingPii` runs on the assembled prompt and can
        // only catch what still looks like the thing it is.
        .map((imp) => imp.split("/")[0].replace(/^@/, ""))
    )
  }

  private assessComplexity(content: string, symbols: AiContextSymbol[]): "low" | "medium" | "high" {
    const lineCount = content.split("\n").length
    const symbolCount = symbols.length
    const nestedDepth = this.calculateMaxNesting(content)

    if (lineCount > 500 || symbolCount > 30 || nestedDepth > 5) {
      return "high"
    } else if (lineCount > 200 || symbolCount > 15 || nestedDepth > 3) {
      return "medium"
    }
    return "low"
  }

  private calculateMaxNesting(content: string): number {
    let maxDepth = 0
    let currentDepth = 0

    for (const char of content) {
      if (char === "{") {
        currentDepth++
        maxDepth = Math.max(maxDepth, currentDepth)
      } else if (char === "}") {
        currentDepth = Math.max(0, currentDepth - 1)
      }
    }

    return maxDepth
  }

  generateContextualPrompt(context: DocumentContext, _actionType: CanvasActionType): string {
    const parts: string[] = []

    parts.push(`Language: ${context.language}`)
    parts.push(`File complexity: ${context.complexity}`)
    parts.push(`Total lines: ${context.lineCount}`)

    if (context.cursorContext.inFunction) {
      parts.push(`Currently in function: ${context.cursorContext.inFunction}`)
    }
    if (context.cursorContext.inClass) {
      parts.push(`Currently in class: ${context.cursorContext.inClass}`)
    }

    if (context.patterns.length > 0) {
      const patternNames = [...new Set(context.patterns.map((p) => p.type))]
      parts.push(`Detected patterns: ${patternNames.join(", ")}`)
    }

    if (context.dependencies.length > 0) {
      parts.push(`Dependencies: ${context.dependencies.slice(0, 5).join(", ")}`)
    }

    if (context.symbols.length > 0) {
      const symbolSummary = context.symbols
        .slice(0, 10)
        .map((s) => `${s.kind}:${s.name}`)
        .join(", ")
      parts.push(`Key symbols: ${symbolSummary}`)
    }

    return parts.join("\n")
  }

  findRelevantSymbols(context: DocumentContext, position: CursorPosition): AiContextSymbol[] {
    return context.symbols.filter(
      (s) => position.line >= s.range.startLine && position.line <= s.range.endLine
    )
  }
}

export const contextAnalyzer = new ContextAnalyzer()

/**
 * Hard ceiling on the scope block. This rides on every suggestion request, so
 * it earns its budget by being short; a document with 400 symbols must not turn
 * a caret-window prompt into a whole-file dump.
 */
export const SCOPE_BLOCK_MAX_CHARS = 400

/**
 * The one prompt-facing entry point: analyse the document around the caret and
 * render a bounded scope summary, or `null` when there is nothing worth saying.
 *
 * Why this exists at all: the suggestion prompt sends a *window* around the
 * caret (`sliceContextWindow`), which is exactly the slice that loses the
 * answers to "what function am I in", "what does this file export", "what does
 * it import". Those are cheap to compute locally and expensive for the model to
 * guess, so they go in explicitly.
 *
 * Never throws — a malformed document degrades to no block, not a failed turn.
 */
export function buildScopeBlock(
  content: string,
  position: CursorPosition,
  language: string,
  actionType: CanvasActionType = "improve"
): string | null {
  if (!content.trim()) return null
  try {
    const context = contextAnalyzer.analyzeContext(content, position, language)
    const body = contextAnalyzer.generateContextualPrompt(context, actionType).trim()
    if (!body) return null
    const trimmed =
      body.length > SCOPE_BLOCK_MAX_CHARS ? `${body.slice(0, SCOPE_BLOCK_MAX_CHARS - 1)}…` : body
    return `Nearby scope:\n${trimmed}`
  } catch (err) {
    loggers.canvas.warn("context-analyzer scope block failed", {
      language,
      error: String(err),
    })
    return null
  }
}

export default ContextAnalyzer
