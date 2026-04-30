/**
 * Comprehensive Tests for Context Analyzer
 */

import { ContextAnalyzer, contextAnalyzer, type DocumentContext } from "./context-analyzer"

describe("ContextAnalyzer", () => {
  let analyzer: ContextAnalyzer

  beforeEach(() => {
    analyzer = new ContextAnalyzer()
  })

  describe("analyzeContext", () => {
    it("should analyze JavaScript code context", () => {
      const code = `
function greet(name) {
  return "Hello, " + name;
}

const result = greet("World");
`
      const context = analyzer.analyzeContext(code, { line: 2, column: 10 }, "javascript")

      expect(context).toBeDefined()
      expect(context.language).toBe("javascript")
      expect(context.symbols.length).toBeGreaterThan(0)
      expect(context.lineCount).toBe(7)
    })

    it("should analyze TypeScript code context", () => {
      const code = `
interface User {
  name: string;
  age: number;
}

function createUser(name: string, age: number): User {
  return { name, age };
}
`
      const context = analyzer.analyzeContext(code, { line: 6, column: 5 }, "typescript")

      expect(context).toBeDefined()
      expect(context.language).toBe("typescript")
      expect(context.symbols.length).toBeGreaterThan(0)
    })

    it("should analyze Python code context", () => {
      const code = `
def calculate(x, y):
    return x + y

class Calculator:
    def __init__(self):
        self.value = 0
`
      const context = analyzer.analyzeContext(code, { line: 2, column: 5 }, "python")

      expect(context).toBeDefined()
      expect(context.language).toBe("python")
    })

    it("should detect imports and exports", () => {
      const code = `
import { useState } from 'react';
import axios from 'axios';

export function MyComponent() {
  return null;
}

export const value = 42;
`
      const context = analyzer.analyzeContext(code, { line: 1, column: 1 }, "javascript")

      expect(context.imports).toContain("react")
      expect(context.imports).toContain("axios")
      expect(context.exports.length).toBeGreaterThan(0)
    })

    it("should detect code patterns", () => {
      const code = `
async function fetchData() {
  try {
    const response = await fetch('/api/data');
    return response.json();
  } catch (error) {
    console.error(error);
  }
}
`
      const context = analyzer.analyzeContext(code, { line: 3, column: 5 }, "javascript")

      expect(context.patterns.length).toBeGreaterThan(0)
      expect(context.patterns.some((p) => p.type === "async-await" || p.type === "try-catch")).toBe(
        true
      )
    })

    it("should assess complexity correctly", () => {
      const simpleCode = "const x = 1;"
      const simpleContext = analyzer.analyzeContext(
        simpleCode,
        { line: 1, column: 1 },
        "javascript"
      )
      expect(simpleContext.complexity).toBe("low")

      const complexCode = Array(300)
        .fill("function f() { if (true) { for (let i = 0; i < 10; i++) { console.log(i); } } }")
        .join("\n")
      const complexContext = analyzer.analyzeContext(
        complexCode,
        { line: 1, column: 1 },
        "javascript"
      )
      expect(["medium", "high"]).toContain(complexContext.complexity)
    })

    it("should analyze cursor context", () => {
      const code = `
class Calculator {
  add(a, b) {
    return a + b;
  }
}
`
      const context = analyzer.analyzeContext(code, { line: 3, column: 5 }, "javascript")

      expect(context.cursorContext.line).toBe(3)
      expect(context.cursorContext.scope.length).toBeGreaterThan(0)
    })
  })

  describe("parseSymbols", () => {
    it("should parse functions", () => {
      const code = `
function greet(name) { return name; }
const arrow = (x) => x * 2;
`
      const symbols = analyzer.parseSymbols(code, "javascript")

      expect(symbols.length).toBeGreaterThan(0)
      const greet = symbols.find((s) => s.name === "greet")
      expect(greet).toBeDefined()
      expect(greet?.kind).toBe("function")
    })

    it("should parse classes", () => {
      const code = `class MyClass { }`
      const symbols = analyzer.parseSymbols(code, "javascript")

      const cls = symbols.find((s) => s.name === "MyClass")
      expect(cls).toBeDefined()
      expect(cls?.kind).toBe("class")
    })

    it("should parse interfaces and types", () => {
      const code = `
interface User { name: string; }
type Status = 'active' | 'inactive';
`
      const symbols = analyzer.parseSymbols(code, "typescript")

      expect(symbols.some((s) => s.name === "User" && s.kind === "interface")).toBe(true)
      expect(symbols.some((s) => s.name === "Status" && s.kind === "type")).toBe(true)
    })

    it("should parse variables", () => {
      const code = `
const a = 1;
let b = 2;
var c = 3;
`
      const symbols = analyzer.parseSymbols(code, "javascript")

      expect(symbols.length).toBeGreaterThanOrEqual(3)
    })

    it("should parse enums", () => {
      const code = `enum Color { Red, Green, Blue }`
      const symbols = analyzer.parseSymbols(code, "typescript")

      const enumSymbol = symbols.find((s) => s.name === "Color")
      expect(enumSymbol).toBeDefined()
      expect(enumSymbol?.kind).toBe("enum")
    })

    it("should handle empty code", () => {
      const symbols = analyzer.parseSymbols("", "javascript")
      expect(symbols).toEqual([])
    })
  })

  describe("extractImports", () => {
    it("should extract named imports", () => {
      const code = `import { useState, useEffect } from 'react';`
      const imports = analyzer.extractImports(code)

      expect(imports).toContain("react")
    })

    it("should extract default imports", () => {
      const code = `import axios from 'axios';`
      const imports = analyzer.extractImports(code)

      expect(imports).toContain("axios")
    })

    it("should extract namespace imports", () => {
      const code = `import * as lodash from 'lodash';`
      const imports = analyzer.extractImports(code)

      expect(imports).toContain("lodash")
    })

    it("should handle multiple imports", () => {
      const code = `
import React from 'react';
import { createStore } from 'redux';
import * as utils from './utils';
`
      const imports = analyzer.extractImports(code)

      expect(imports).toContain("react")
      expect(imports).toContain("redux")
      expect(imports).toContain("./utils")
    })
  })

  describe("extractExports", () => {
    it("should extract named exports", () => {
      const code = `export function myFunc() {}`
      const exports = analyzer.extractExports(code)

      expect(exports).toContain("myFunc")
    })

    it("should extract default exports", () => {
      const code = `export default function App() {}`
      const exports = analyzer.extractExports(code)

      expect(exports).toContain("App")
    })

    it("should extract const exports", () => {
      const code = `export const value = 42;`
      const exports = analyzer.extractExports(code)

      expect(exports).toContain("value")
    })

    it("should extract re-exports", () => {
      const code = `export { foo, bar };`
      const exports = analyzer.extractExports(code)

      expect(exports).toContain("foo")
      expect(exports).toContain("bar")
    })
  })

  describe("findPatterns", () => {
    it("should detect React patterns", () => {
      const code = `
export function MyComponent() {
  const [state, setState] = useState(0);
  return <div>{state}</div>;
}
`
      const patterns = analyzer.findPatterns(code, "javascript")

      expect(patterns.some((p) => p.type === "react-hook")).toBe(true)
    })

    it("should detect async patterns", () => {
      const code = `async function fetchData() { await fetch('/api'); }`
      const patterns = analyzer.findPatterns(code, "javascript")

      expect(patterns.some((p) => p.type === "async-await")).toBe(true)
    })

    it("should detect try-catch patterns", () => {
      const code = `try { doSomething(); } catch (e) { handleError(e); }`
      const patterns = analyzer.findPatterns(code, "javascript")

      expect(patterns.some((p) => p.type === "try-catch")).toBe(true)
    })

    it("should detect class patterns", () => {
      const code = `class MyClass extends BaseClass { }`
      const patterns = analyzer.findPatterns(code, "javascript")

      expect(patterns.some((p) => p.type === "class-based")).toBe(true)
    })

    it("should detect destructuring patterns", () => {
      const code = `const { a, b } = obj;`
      const patterns = analyzer.findPatterns(code, "javascript")

      expect(patterns.some((p) => p.type === "destructuring")).toBe(true)
    })
  })

  describe("generateContextualPrompt", () => {
    it("should generate prompt with language info", () => {
      const context: DocumentContext = {
        language: "typescript",
        symbols: [],
        imports: [],
        exports: [],
        cursorContext: {
          line: 1,
          column: 1,
          inFunction: null,
          inClass: null,
          inBlock: null,
          scope: [],
        },
        patterns: [],
        dependencies: [],
        lineCount: 10,
        complexity: "low",
      }

      const prompt = analyzer.generateContextualPrompt(context, "explain")

      expect(prompt).toContain("typescript")
      expect(prompt).toContain("low")
    })

    it("should include function context", () => {
      const context: DocumentContext = {
        language: "javascript",
        symbols: [{ name: "myFunc", kind: "function", range: { startLine: 1, endLine: 5 } }],
        imports: [],
        exports: [],
        cursorContext: {
          line: 3,
          column: 1,
          inFunction: "myFunc",
          inClass: null,
          inBlock: null,
          scope: ["myFunc"],
        },
        patterns: [],
        dependencies: [],
        lineCount: 10,
        complexity: "low",
      }

      const prompt = analyzer.generateContextualPrompt(context, "fix")

      expect(prompt).toContain("myFunc")
    })

    it("should include dependencies", () => {
      const context: DocumentContext = {
        language: "javascript",
        symbols: [],
        imports: ["react", "lodash"],
        exports: [],
        cursorContext: {
          line: 1,
          column: 1,
          inFunction: null,
          inClass: null,
          inBlock: null,
          scope: [],
        },
        patterns: [],
        dependencies: ["react", "lodash"],
        lineCount: 10,
        complexity: "low",
      }

      const prompt = analyzer.generateContextualPrompt(context, "improve")

      expect(prompt).toContain("react")
    })
  })

  describe("findRelevantSymbols", () => {
    it("should find symbols at cursor position", () => {
      const context: DocumentContext = {
        language: "javascript",
        symbols: [
          { name: "func1", kind: "function", range: { startLine: 1, endLine: 5 } },
          { name: "func2", kind: "function", range: { startLine: 10, endLine: 15 } },
        ],
        imports: [],
        exports: [],
        cursorContext: {
          line: 3,
          column: 1,
          inFunction: "func1",
          inClass: null,
          inBlock: null,
          scope: [],
        },
        patterns: [],
        dependencies: [],
        lineCount: 20,
        complexity: "low",
      }

      const relevant = analyzer.findRelevantSymbols(context, { line: 3, column: 1 })

      expect(relevant.length).toBe(1)
      expect(relevant[0].name).toBe("func1")
    })

    it("should return empty when cursor is outside all symbols", () => {
      const context: DocumentContext = {
        language: "javascript",
        symbols: [{ name: "func1", kind: "function", range: { startLine: 1, endLine: 5 } }],
        imports: [],
        exports: [],
        cursorContext: {
          line: 10,
          column: 1,
          inFunction: null,
          inClass: null,
          inBlock: null,
          scope: [],
        },
        patterns: [],
        dependencies: [],
        lineCount: 20,
        complexity: "low",
      }

      const relevant = analyzer.findRelevantSymbols(context, { line: 10, column: 1 })

      expect(relevant.length).toBe(0)
    })
  })

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(contextAnalyzer).toBeInstanceOf(ContextAnalyzer)
    })

    it("should have all methods available", () => {
      expect(typeof contextAnalyzer.analyzeContext).toBe("function")
      expect(typeof contextAnalyzer.parseSymbols).toBe("function")
      expect(typeof contextAnalyzer.extractImports).toBe("function")
      expect(typeof contextAnalyzer.extractExports).toBe("function")
      expect(typeof contextAnalyzer.findPatterns).toBe("function")
      expect(typeof contextAnalyzer.generateContextualPrompt).toBe("function")
      expect(typeof contextAnalyzer.findRelevantSymbols).toBe("function")
    })
  })
})
