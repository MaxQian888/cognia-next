import type { CodeChunk } from "../types"
import { buildImportGraph, extractImportSpecifiers, resolveSpecifierToModule } from "./import-graph"

function chunk(over: Partial<CodeChunk> & { filePath: string; content: string }): CodeChunk {
  const filePath = over.filePath
  const mod = over.module ?? filePath.split("/").slice(0, -1).join("/")
  return {
    id: over.id ?? filePath,
    filePath,
    module: mod,
    lineStart: 1,
    lineEnd: 10,
    tokenCount: 10,
    content: over.content,
    fileHash: "h",
  }
}

describe("extractImportSpecifiers", () => {
  it("pulls JS/TS import / require / dynamic-import / export-from specifiers", () => {
    const src = `
      import { a } from "./a";
      import "./side-effect";
      const b = require("../b");
      export { c } from "./c";
      const d = await import("@/lib/d");
    `
    expect(extractImportSpecifiers(src, "src/x.ts").sort()).toEqual(
      ["../b", "./a", "./c", "./side-effect", "@/lib/d"].sort()
    )
  })

  it("pulls Python from/import specifiers", () => {
    const src = `from pkg.mod import thing\nimport other.lib\n`
    expect(extractImportSpecifiers(src, "pkg/main.py")).toEqual(["pkg.mod", "other.lib"])
  })

  it("pulls Rust use paths", () => {
    expect(extractImportSpecifiers(`use crate::foo::Bar;\n`, "src/lib.rs")).toEqual([
      "crate::foo::Bar",
    ])
  })

  it("returns [] for unknown extensions / empty content", () => {
    expect(extractImportSpecifiers("import x", "a.md")).toEqual([])
    expect(extractImportSpecifiers("", "a.ts")).toEqual([])
  })
})

describe("resolveSpecifierToModule", () => {
  const known = new Set(["src", "src/util", "lib/d"])

  it("resolves a relative specifier to the target module dir", () => {
    expect(resolveSpecifierToModule("./fmt", "src/app.ts", known)).toBe("src")
    expect(resolveSpecifierToModule("../util/log", "src/app/x.ts", known)).toBe("src/util")
  })

  it("resolves a @/ alias against the repo root", () => {
    expect(resolveSpecifierToModule("@/lib/d/thing", "src/app.ts", known)).toBe("lib/d")
  })

  it("returns null for bare packages / dirs outside the known set", () => {
    expect(resolveSpecifierToModule("react", "src/app.ts", known)).toBeNull()
    // resolves to the root-level dir "external", which isn't a known module.
    expect(resolveSpecifierToModule("../../external/x", "src/app.ts", known)).toBeNull()
  })
})

describe("buildImportGraph", () => {
  it("builds importer→imported module edges, dropping self + unknown", () => {
    const chunks = [
      chunk({ filePath: "src/app.ts", content: `import { format } from "./util/fmt";` }),
      chunk({ filePath: "src/util/fmt.ts", content: `export const format = (s: string) => s;` }),
      // imports an external package → no edge
      chunk({ filePath: "src/app2.ts", content: `import React from "react";` }),
    ]
    const g = buildImportGraph(chunks)
    expect([...(g.get("src") ?? [])]).toEqual(["src/util"])
    expect(g.has("src/util")).toBe(false) // fmt imports nothing internal
  })

  it("returns an empty graph when there are no internal imports", () => {
    const chunks = [chunk({ filePath: "a/x.ts", content: `import fs from "node:fs";` })]
    expect(buildImportGraph(chunks).size).toBe(0)
  })
})
