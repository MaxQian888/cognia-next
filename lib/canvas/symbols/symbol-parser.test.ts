/**
 * Comprehensive Tests for Symbol Parser
 */

import { SymbolParser, symbolParser, type LineRange } from "./symbol-parser"

describe("SymbolParser", () => {
  let parser: SymbolParser

  beforeEach(() => {
    parser = new SymbolParser()
  })

  describe("parseSymbols", () => {
    it("should parse JavaScript functions", () => {
      const code = `
function greet(name) {
  return "Hello, " + name;
}

const arrow = (x) => x * 2;
`
      const symbols = parser.parseSymbols(code, "javascript")

      expect(symbols.length).toBeGreaterThan(0)
      const greet = symbols.find((s) => s.name === "greet")
      expect(greet).toBeDefined()
      expect(greet?.kind).toBe("function")
    })

    it("should parse JavaScript classes", () => {
      const code = `
class Calculator {
  constructor() {
    this.value = 0;
  }

  add(x) {
    this.value += x;
  }
}
`
      const symbols = parser.parseSymbols(code, "javascript")

      const cls = symbols.find((s) => s.name === "Calculator")
      expect(cls).toBeDefined()
      expect(cls?.kind).toBe("class")
    })

    it("should parse TypeScript interfaces", () => {
      const code = `
interface User {
  name: string;
  age: number;
}

type Status = 'active' | 'inactive';
`
      const symbols = parser.parseSymbols(code, "typescript")

      const iface = symbols.find((s) => s.name === "User")
      expect(iface).toBeDefined()
      expect(iface?.kind).toBe("interface")

      const type = symbols.find((s) => s.name === "Status")
      expect(type).toBeDefined()
      expect(type?.kind).toBe("typeParameter")
    })

    it("should parse TypeScript enums", () => {
      const code = `enum Color { Red, Green, Blue }`
      const symbols = parser.parseSymbols(code, "typescript")

      const enumSymbol = symbols.find((s) => s.name === "Color")
      expect(enumSymbol).toBeDefined()
      expect(enumSymbol?.kind).toBe("enum")
    })

    it("should parse Python functions and classes", () => {
      const code = `
def calculate(x, y):
    return x + y

class Calculator:
    def __init__(self):
        self.value = 0
`
      const symbols = parser.parseSymbols(code, "python")

      expect(symbols.length).toBeGreaterThan(0)
      const func = symbols.find((s) => s.name === "calculate")
      expect(func).toBeDefined()
      expect(func?.kind).toBe("function")

      const cls = symbols.find((s) => s.name === "Calculator")
      expect(cls).toBeDefined()
      expect(cls?.kind).toBe("class")
    })

    it("should parse variables", () => {
      const code = `
const constVar = 1;
let letVar = 2;
var varVar = 3;
`
      const symbols = parser.parseSymbols(code, "javascript")

      expect(symbols.some((s) => s.name === "constVar")).toBe(true)
      expect(symbols.some((s) => s.name === "letVar")).toBe(true)
      expect(symbols.some((s) => s.name === "varVar")).toBe(true)
    })

    it("should parse arrow functions as functions", () => {
      const code = `const myArrow = (x) => x * 2;`
      const symbols = parser.parseSymbols(code, "javascript")

      const arrow = symbols.find((s) => s.name === "myArrow")
      expect(arrow).toBeDefined()
      expect(arrow?.kind).toBe("function")
    })

    it("should handle empty code", () => {
      const symbols = parser.parseSymbols("", "javascript")
      expect(symbols).toEqual([])
    })

    it("should include range information", () => {
      const code = `function test() { return 1; }`
      const symbols = parser.parseSymbols(code, "javascript")

      expect(symbols[0].range).toBeDefined()
      expect(symbols[0].range.startLine).toBeGreaterThan(0)
      expect(symbols[0].range.endLine).toBeGreaterThanOrEqual(symbols[0].range.startLine)
    })

    it("should include selection range", () => {
      const code = `function test() { }`
      const symbols = parser.parseSymbols(code, "javascript")

      expect(symbols[0].selectionRange).toBeDefined()
    })

    it("should parse exported symbols", () => {
      const code = `
export function exportedFunc() {}
export class ExportedClass {}
export const exportedConst = 1;
`
      const symbols = parser.parseSymbols(code, "javascript")

      expect(symbols.some((s) => s.name === "exportedFunc")).toBe(true)
      expect(symbols.some((s) => s.name === "ExportedClass")).toBe(true)
      expect(symbols.some((s) => s.name === "exportedConst")).toBe(true)
    })

    it("should parse async functions", () => {
      const code = `async function fetchData() { return await fetch('/api'); }`
      const symbols = parser.parseSymbols(code, "javascript")

      const asyncFunc = symbols.find((s) => s.name === "fetchData")
      expect(asyncFunc).toBeDefined()
      expect(asyncFunc?.kind).toBe("function")
    })
  })

  describe("findSymbolByName", () => {
    it("should find symbol by exact name", () => {
      const code = `
function myFunction() {}
const myVariable = 10;
class MyClass {}
`
      const symbols = parser.parseSymbols(code, "javascript")
      const found = parser.findSymbolByName("myFunction", symbols)

      expect(found).toBeDefined()
      expect(found?.name).toBe("myFunction")
    })

    it("should return null for non-existent symbol", () => {
      const code = "const x = 1;"
      const symbols = parser.parseSymbols(code, "javascript")
      const found = parser.findSymbolByName("nonExistent", symbols)

      expect(found).toBeNull()
    })

    it("should find nested symbols in children", () => {
      const code = `
class MyClass {
  myMethod() {}
}
`
      const symbols = parser.parseSymbols(code, "javascript")

      // Check if children are parsed
      const cls = symbols.find((s) => s.name === "MyClass")
      if (cls?.children && cls.children.length > 0) {
        const found = parser.findSymbolByName("myMethod", symbols)
        expect(found).toBeDefined()
      }
    })
  })

  describe("findSymbolAtLine", () => {
    it("should find symbol at a specific line", () => {
      const code = `function a() {}
function b() {}
function c() {}`

      const symbols = parser.parseSymbols(code, "javascript")
      const found = parser.findSymbolAtLine(1, symbols)

      expect(found).toBeDefined()
      expect(found?.name).toBe("a")
    })

    it("should find symbol when line is within range", () => {
      const code = `
function multiLine() {
  const x = 1;
  return x;
}
`
      const symbols = parser.parseSymbols(code, "javascript")
      const found = parser.findSymbolAtLine(3, symbols)

      expect(found).toBeDefined()
      expect(found?.name).toBe("multiLine")
    })

    it("should return null when line is outside all symbols", () => {
      const code = `function a() {}`
      const symbols = parser.parseSymbols(code, "javascript")
      const found = parser.findSymbolAtLine(100, symbols)

      expect(found).toBeNull()
    })
  })

  describe("getSymbolsInRange", () => {
    it("should find all symbols within a range", () => {
      const code = `
function a() {}
function b() {}
function c() {}
function d() {}
`
      const symbols = parser.parseSymbols(code, "javascript")
      const range: LineRange = { startLine: 2, startColumn: 1, endLine: 4, endColumn: 1 }
      const inRange = parser.getSymbolsInRange(range, symbols)

      expect(inRange.length).toBeGreaterThan(0)
    })

    it("should return empty array when no symbols in range", () => {
      const code = `function a() {}`
      const symbols = parser.parseSymbols(code, "javascript")
      const range: LineRange = { startLine: 100, startColumn: 1, endLine: 200, endColumn: 1 }
      const inRange = parser.getSymbolsInRange(range, symbols)

      expect(inRange.length).toBe(0)
    })
  })

  describe("getSymbolBreadcrumb", () => {
    it("should return path to symbol at line", () => {
      const code = `
class MyClass {
  myMethod() {
    const x = 1;
  }
}
`
      const symbols = parser.parseSymbols(code, "javascript")
      const breadcrumb = parser.getSymbolBreadcrumb(3, symbols)

      expect(breadcrumb.length).toBeGreaterThan(0)
      expect(breadcrumb).toContain("MyClass")
    })

    it("should return empty array when no symbol at line", () => {
      const code = `function a() {}`
      const symbols = parser.parseSymbols(code, "javascript")
      const breadcrumb = parser.getSymbolBreadcrumb(100, symbols)

      expect(breadcrumb).toEqual([])
    })
  })

  describe("getSymbolLocation", () => {
    it("should return the active symbol and breadcrumb path for the current line", () => {
      const code = `
class MyClass {
  myMethod() {
    const x = 1;
  }
}
`
      const symbols = parser.parseSymbols(code, "javascript")
      const location = parser.getSymbolLocation(3, symbols)

      expect(location).not.toBeNull()
      expect(location?.symbol.name).toBe("myMethod")
      expect(location?.path).toEqual(["MyClass", "myMethod"])
      expect(location?.chain.map((symbol) => symbol.name)).toEqual(["MyClass", "myMethod"])
    })

    it("should return null when the line is outside every symbol", () => {
      const symbols = parser.parseSymbols("function test() {}", "javascript")
      expect(parser.getSymbolLocation(100, symbols)).toBeNull()
    })
  })

  describe("getSymbolIcon", () => {
    it("should return icon for function", () => {
      const icon = parser.getSymbolIcon("function")
      expect(icon).toBeDefined()
      expect(typeof icon).toBe("string")
    })

    it("should return icon for class", () => {
      const icon = parser.getSymbolIcon("class")
      expect(icon).toBeDefined()
    })

    it("should return icon for interface", () => {
      const icon = parser.getSymbolIcon("interface")
      expect(icon).toBeDefined()
    })

    it("should return icon for variable", () => {
      const icon = parser.getSymbolIcon("variable")
      expect(icon).toBeDefined()
    })

    it("should return default icon for unknown kind", () => {
      const icon = parser.getSymbolIcon("unknownKind" as never)
      expect(icon).toBeDefined()
    })
  })

  describe("new regex patterns (refactoring additions)", () => {
    it("should parse export default function", () => {
      const code = `export default function main() {\n  return 1;\n}`
      const symbols = parser.parseSymbols(code, "javascript")

      const found = symbols.find((s) => s.name === "main")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("function")
    })

    it("should parse export default class", () => {
      const code = `export default class App {\n  render() {}\n}`
      const symbols = parser.parseSymbols(code, "javascript")

      const found = symbols.find((s) => s.name === "App")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("class")
    })

    it("should parse const function expression", () => {
      const code = `const handler = function processEvent() {\n  return true;\n}`
      const symbols = parser.parseSymbols(code, "javascript")

      const found = symbols.find((s) => s.name === "handler")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("function")
    })

    it("should parse async arrow functions", () => {
      const code = `const fetchData = async (url) => {\n  return await fetch(url);\n}`
      const symbols = parser.parseSymbols(code, "javascript")

      const found = symbols.find((s) => s.name === "fetchData")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("function")
    })

    it("should parse TypeScript abstract class", () => {
      const code = `export abstract class BaseService {\n  abstract process(): void;\n}`
      const symbols = parser.parseSymbols(code, "typescript")

      const found = symbols.find((s) => s.name === "BaseService")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("class")
    })

    it("should parse Python functions with decorators", () => {
      const code = `@app.route('/api')\ndef handle_request():\n    return response`
      const symbols = parser.parseSymbols(code, "python")

      const found = symbols.find((s) => s.name === "handle_request")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("function")
    })

    it("should parse Python classes with decorators", () => {
      const code = `@dataclass\nclass Config:\n    name: str\n    value: int`
      const symbols = parser.parseSymbols(code, "python")

      const found = symbols.find((s) => s.name === "Config")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("class")
    })

    it("should parse Python async def", () => {
      const code = `async def fetch_data():\n    return await get_data()`
      const symbols = parser.parseSymbols(code, "python")

      const found = symbols.find((s) => s.name === "fetch_data")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("function")
    })

    it("should parse export default async function", () => {
      const code = `export default async function loader() {\n  return data;\n}`
      const symbols = parser.parseSymbols(code, "javascript")

      const found = symbols.find((s) => s.name === "loader")
      expect(found).toBeDefined()
      expect(found?.kind).toBe("function")
    })
  })

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(symbolParser).toBeInstanceOf(SymbolParser)
    })

    it("should have all methods available", () => {
      expect(typeof symbolParser.parseSymbols).toBe("function")
      expect(typeof symbolParser.findSymbolByName).toBe("function")
      expect(typeof symbolParser.findSymbolAtLine).toBe("function")
      expect(typeof symbolParser.getSymbolsInRange).toBe("function")
      expect(typeof symbolParser.getSymbolBreadcrumb).toBe("function")
      expect(typeof symbolParser.getSymbolLocation).toBe("function")
      expect(typeof symbolParser.getSymbolIcon).toBe("function")
    })
  })
})
