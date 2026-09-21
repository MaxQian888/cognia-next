import { FILE_TEMPLATES, templateById } from "./file-templates"

describe("FILE_TEMPLATES", () => {
  it("every template id resolves back to itself", () => {
    for (const template of FILE_TEMPLATES) {
      expect(templateById(template.id)).toBe(template)
    }
  })

  it("has unique ids", () => {
    const ids = FILE_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("templateById", () => {
  it("falls back to the empty template for unknown ids", () => {
    expect(templateById("does-not-exist").id).toBe("empty")
    expect(templateById("").id).toBe("empty")
  })
})

describe("reactComponent template", () => {
  const content = (name: string) =>
    FILE_TEMPLATES.find((t) => t.id === "reactComponent")!.content(name)

  it("derives a PascalCase component name from a kebab-case filename", () => {
    expect(content("my-widget.tsx")).toContain("export function MyWidget()")
    expect(content("my-widget.tsx")).toContain("<div>MyWidget</div>")
  })

  it("uses the final path segment, not the directory", () => {
    expect(content("src/deep/nested/card.tsx")).toContain("export function Card()")
  })

  it("falls back to a safe identifier for names that can't be one", () => {
    expect(content("123.tsx")).toContain("export function Component()")
    expect(content("---.tsx")).toContain("export function Component()")
  })
})

describe("title-bearing templates", () => {
  const titleOf = (id: string, name: string) =>
    FILE_TEMPLATES.find((t) => t.id === id)!.content(name)

  it("markdown uses the file stem as the heading", () => {
    expect(titleOf("markdown", "docs/guide.md")).toBe("# guide\n")
  })

  it("html and test templates title from the stem", () => {
    expect(titleOf("html", "pages/about.html")).toContain("<title>about</title>")
    expect(titleOf("test", "sum.test.ts")).toContain('describe("sum.test"')
  })
})

describe("scaffold validity", () => {
  it("typescript emits a module marker", () => {
    expect(templateById("typescript").content("index.ts")).toBe("export {}\n")
  })

  it("shell emits a strict bash preamble", () => {
    const body = templateById("shell").content("script.sh")
    expect(body).toContain("#!/usr/bin/env bash")
    expect(body).toContain("set -euo pipefail")
  })

  it("python emits a runnable main guard", () => {
    expect(templateById("python").content("main.py")).toContain('if __name__ == "__main__":')
  })

  it("empty and css templates write nothing", () => {
    expect(templateById("empty").content("a.txt")).toBe("")
    expect(templateById("css").content("a.css")).toBe("")
  })
})
