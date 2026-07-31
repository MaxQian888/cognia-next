/**
 * Context Analyzer - Intelligent code context analysis for better AI suggestions.
 *
 * NOTE: `AiContextSymbol` is intentionally narrower than the full IDE
 * `AiContextSymbol` from `@/types/canvas/symbols`. This shape is the
 * lightweight summary fed into LLM prompts (kind enum + line range only),
 * so we keep it local and don't unify the two.
 */

import { loggers } from "@cognia/logging"
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

export class ContextAnalyzer {
  private symbolPatterns: Record<string, RegExp[]> = {
    function: [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/g,
      /(\w+)\s*:\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    ],
    class: [/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g],
    interface: [/(?:export\s+)?interface\s+(\w+)/g],
    type: [/(?:export\s+)?type\s+(\w+)/g],
    variable: [/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::|=)/g],
    import: [
      /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
    ],
    enum: [/(?:export\s+)?enum\s+(\w+)/g],
  }

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

  parseSymbols(content: string, language: string): AiContextSymbol[] {
    const symbols: AiContextSymbol[] = []
    const lines = content.split("\n")

    try {
      for (const [kind, patterns] of Object.entries(this.symbolPatterns)) {
        for (const pattern of patterns) {
          pattern.lastIndex = 0
          let match
          while ((match = pattern.exec(content)) !== null) {
            const lineNumber = content.substring(0, match.index).split("\n").length
            const endLine = this.findBlockEnd(lines, lineNumber - 1)

            symbols.push({
              name: match[1],
              kind: kind as AiContextSymbol["kind"],
              range: {
                startLine: lineNumber,
                endLine: endLine + 1,
              },
            })
          }
        }
      }
    } catch (err) {
      loggers.canvas.warn("context-analyzer parseSymbols failed", {
        language,
        error: String(err),
      })
    }

    return symbols.sort((a, b) => a.range.startLine - b.range.startLine)
  }

  private findBlockEnd(lines: string[], startLine: number): number {
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

    return startLine
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
    return imports
      .filter((imp) => !imp.startsWith(".") && !imp.startsWith("@/"))
      .map((imp) => imp.split("/")[0].replace("@", ""))
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

export default ContextAnalyzer
