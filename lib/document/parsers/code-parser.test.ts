/**
 * Tests for Code Parser
 */

import { detectLanguage, parseCode, extractCodeEmbeddableContent } from "./code-parser"

describe("detectLanguage", () => {
  describe("JavaScript/TypeScript", () => {
    it("detects JavaScript", () => {
      expect(detectLanguage("app.js")).toBe("javascript")
    })

    it("detects JSX", () => {
      expect(detectLanguage("component.jsx")).toBe("javascript")
    })

    it("detects TypeScript", () => {
      expect(detectLanguage("app.ts")).toBe("typescript")
    })

    it("detects TSX", () => {
      expect(detectLanguage("component.tsx")).toBe("typescript")
    })
  })

  describe("Python", () => {
    it("detects Python", () => {
      expect(detectLanguage("script.py")).toBe("python")
    })
  })

  describe("Go", () => {
    it("detects Go", () => {
      expect(detectLanguage("main.go")).toBe("go")
    })
  })

  describe("Rust", () => {
    it("detects Rust", () => {
      expect(detectLanguage("lib.rs")).toBe("rust")
    })
  })

  describe("C/C++", () => {
    it("detects C", () => {
      expect(detectLanguage("main.c")).toBe("c")
    })

    it("detects C header", () => {
      expect(detectLanguage("header.h")).toBe("c")
    })

    it("detects C++", () => {
      expect(detectLanguage("main.cpp")).toBe("cpp")
    })

    it("detects C++ header", () => {
      expect(detectLanguage("header.hpp")).toBe("cpp")
    })
  })

  describe("Java/Kotlin", () => {
    it("detects Java", () => {
      expect(detectLanguage("Main.java")).toBe("java")
    })

    it("detects Kotlin", () => {
      expect(detectLanguage("Main.kt")).toBe("kotlin")
    })
  })

  describe("Shell scripts", () => {
    it("detects Bash", () => {
      expect(detectLanguage("script.sh")).toBe("bash")
      expect(detectLanguage("script.bash")).toBe("bash")
      expect(detectLanguage("script.zsh")).toBe("bash")
    })

    it("detects PowerShell", () => {
      expect(detectLanguage("script.ps1")).toBe("powershell")
    })
  })

  describe("Web technologies", () => {
    it("detects HTML", () => {
      expect(detectLanguage("index.html")).toBe("html")
    })

    it("detects CSS", () => {
      expect(detectLanguage("style.css")).toBe("css")
    })

    it("detects SCSS", () => {
      expect(detectLanguage("style.scss")).toBe("scss")
    })

    it("detects Vue", () => {
      expect(detectLanguage("component.vue")).toBe("vue")
    })

    it("detects Svelte", () => {
      expect(detectLanguage("component.svelte")).toBe("svelte")
    })
  })

  describe("Data formats", () => {
    it("detects JSON", () => {
      expect(detectLanguage("config.json")).toBe("json")
    })

    it("detects YAML", () => {
      expect(detectLanguage("config.yaml")).toBe("yaml")
      expect(detectLanguage("config.yml")).toBe("yaml")
    })

    it("detects XML", () => {
      expect(detectLanguage("config.xml")).toBe("xml")
    })

    it("detects SQL", () => {
      expect(detectLanguage("query.sql")).toBe("sql")
    })
  })

  describe("Other languages", () => {
    it("detects Ruby", () => {
      expect(detectLanguage("script.rb")).toBe("ruby")
    })

    it("detects PHP", () => {
      expect(detectLanguage("index.php")).toBe("php")
    })

    it("detects Swift", () => {
      expect(detectLanguage("app.swift")).toBe("swift")
    })

    it("detects Scala", () => {
      expect(detectLanguage("Main.scala")).toBe("scala")
    })

    it("detects C#", () => {
      expect(detectLanguage("Program.cs")).toBe("csharp")
    })

    it("detects R", () => {
      expect(detectLanguage("script.r")).toBe("r")
    })
  })

  describe("Unknown extensions", () => {
    it("returns text for unknown", () => {
      expect(detectLanguage("file.xyz")).toBe("text")
    })

    it("returns text for no extension", () => {
      expect(detectLanguage("Makefile")).toBe("text")
    })
  })
})

describe("parseCode", () => {
  describe("JavaScript/TypeScript parsing", () => {
    it("extracts named imports", () => {
      const code = `import { useState, useEffect } from 'react';`
      const result = parseCode(code, "app.ts")

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].module).toBe("react")
      expect(result.imports[0].items).toContain("useState")
      expect(result.imports[0].items).toContain("useEffect")
    })

    it("extracts default imports", () => {
      const code = `import React from 'react';`
      const result = parseCode(code, "app.ts")

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].module).toBe("react")
      expect(result.imports[0].items).toContain("React")
    })

    it("extracts side-effect imports", () => {
      const code = `import './styles.css';`
      const result = parseCode(code, "app.ts")

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].module).toBe("./styles.css")
    })

    it("extracts function declarations", () => {
      const code = `function hello() {
  return "world";
}`
      const result = parseCode(code, "app.ts")

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0].name).toBe("hello")
    })

    it("extracts arrow functions", () => {
      const code = `const greet = () => {
  return "hi";
};`
      const result = parseCode(code, "app.ts")

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0].name).toBe("greet")
    })

    it("extracts async functions", () => {
      const code = `async function fetchData() {
  return await fetch('/api');
}`
      const result = parseCode(code, "app.ts")

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0].name).toBe("fetchData")
    })

    it("extracts exported functions", () => {
      const code = `export function helper() {
  return true;
}`
      const result = parseCode(code, "app.ts")

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0].name).toBe("helper")
    })

    it("extracts single-line comments", () => {
      const code = `// This is a comment
const x = 1;`
      const result = parseCode(code, "app.ts")

      expect(result.comments).toContain("This is a comment")
    })

    it("extracts multi-line comments", () => {
      const code = `/* Multi-line
comment here */
const x = 1;`
      const result = parseCode(code, "app.ts")

      expect(result.comments.some((c) => c.includes("Multi-line"))).toBe(true)
    })
  })

  describe("Python parsing", () => {
    it("extracts from imports", () => {
      const code = `from typing import List, Dict`
      const result = parseCode(code, "script.py")

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].module).toBe("typing")
      expect(result.imports[0].items).toContain("List")
      expect(result.imports[0].items).toContain("Dict")
    })

    it("extracts simple imports", () => {
      const code = `import os`
      const result = parseCode(code, "script.py")

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].module).toBe("os")
    })

    it("extracts function definitions", () => {
      const code = `def hello():
    return "world"`
      const result = parseCode(code, "script.py")

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0].name).toBe("hello")
    })

    it("extracts async functions", () => {
      const code = `async def fetch_data():
    return await get_data()`
      const result = parseCode(code, "script.py")

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0].name).toBe("fetch_data")
    })

    it("extracts hash comments", () => {
      const code = `# This is a comment
x = 1`
      const result = parseCode(code, "script.py")

      expect(result.comments).toContain("This is a comment")
    })

    it("extracts docstrings", () => {
      const code = `"""
This is a docstring
"""
def func():
    pass`
      const result = parseCode(code, "script.py")

      expect(result.comments.some((c) => c.includes("docstring"))).toBe(true)
    })
  })

  describe("result structure", () => {
    it("includes language", () => {
      const result = parseCode("const x = 1;", "app.ts")

      expect(result.language).toBe("typescript")
    })

    it("includes original content", () => {
      const code = "const x = 1;"
      const result = parseCode(code, "app.ts")

      expect(result.content).toBe(code)
    })

    it("handles empty content", () => {
      const result = parseCode("", "app.ts")

      expect(result.imports).toHaveLength(0)
      expect(result.functions).toHaveLength(0)
    })
  })
})

describe("extractCodeEmbeddableContent", () => {
  it("includes comments", () => {
    const code = `// Important comment
const x = 1;`
    const result = extractCodeEmbeddableContent(code, "app.ts")

    expect(result).toContain("Important comment")
  })

  it("includes function signatures", () => {
    const code = `function calculateSum(a, b) {
  return a + b;
}`
    const result = extractCodeEmbeddableContent(code, "app.ts")

    expect(result).toContain("calculateSum")
  })

  it("includes JSDoc comments", () => {
    const code = `/**
 * Calculates the sum
 */
function sum() {
  return 1;
}`
    const result = extractCodeEmbeddableContent(code, "app.ts")

    expect(result).toContain("Calculates the sum")
  })

  it("handles code without comments or functions", () => {
    const code = `const x = 1;
const y = 2;`
    const result = extractCodeEmbeddableContent(code, "app.ts")

    expect(typeof result).toBe("string")
  })
})
