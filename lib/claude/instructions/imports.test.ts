import { expandImports } from "./imports"
import type { InstructionFs } from "./types"

function fakeFs(files: Record<string, string>): InstructionFs {
  const norm = (p: string) => p.replace(/\\/g, "/")
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  return {
    async exists(p) {
      return map.has(norm(p))
    },
    async readDir() {
      return []
    },
    async readText(p) {
      const v = map.get(norm(p))
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
  }
}

describe("expandImports", () => {
  it("inlines a referenced file relative to the base dir", async () => {
    const fs = fakeFs({ "/proj/shared.md": "shared rules" })
    const r = await expandImports("see @shared.md for rules", "/proj", fs)
    expect(r.content).toBe("see shared rules for rules")
    expect(r.imported).toEqual(["/proj/shared.md"])
  })

  it("expands recursively", async () => {
    const fs = fakeFs({
      "/proj/a.md": "A then @b.md",
      "/proj/b.md": "B done",
    })
    const r = await expandImports("@a.md", "/proj", fs)
    expect(r.content).toBe("A then B done")
  })

  it("breaks cycles via the seen set", async () => {
    const fs = fakeFs({
      "/proj/a.md": "A @b.md",
      "/proj/b.md": "B @a.md",
    })
    const r = await expandImports("@a.md", "/proj", fs)
    expect(r.content).toContain("A B")
    expect(r.warnings.some((w) => /circular/.test(w))).toBe(true)
  })

  it("honours the depth limit", async () => {
    const fs = fakeFs({
      "/proj/a.md": "A @b.md",
      "/proj/b.md": "B @c.md",
      "/proj/c.md": "C",
    })
    const r = await expandImports("@a.md", "/proj", fs, { maxDepth: 1 })
    // a.md inlines (1st level); b.md (2nd level) is blocked and left as a token.
    expect(r.content).toBe("A @b.md")
    expect(r.content).not.toContain("C")
    expect(r.warnings.some((w) => /depth limit/.test(w))).toBe(true)
  })

  it("leaves non-path @tokens (emails) untouched", async () => {
    const fs = fakeFs({})
    const r = await expandImports("contact me@example", "/proj", fs)
    expect(r.content).toBe("contact me@example")
    expect(r.imported).toEqual([])
  })

  it("ignores @imports inside fenced code blocks", async () => {
    const fs = fakeFs({ "/proj/x.md": "REAL" })
    const input = "```\n@x.md\n```\n@x.md"
    const r = await expandImports(input, "/proj", fs)
    expect(r.content).toBe("```\n@x.md\n```\nREAL")
  })

  it("leaves a token whose file is missing as-is", async () => {
    const fs = fakeFs({})
    const r = await expandImports("@./missing.md", "/proj", fs)
    expect(r.content).toBe("@./missing.md")
  })
})
