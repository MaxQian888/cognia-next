import JSZip from "jszip"
import { loadBundle, type BundleInput } from "./loader"
import type { BundleFs } from "./walk-folder"

const SKILL_MD = `---
name: Code Review
description: Reviews code
---
Body.
`

const CODEX_OPENAI_YAML = `interface:
  display_name: Code Review (Codex)
`

async function buildZip(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, body] of Object.entries(entries)) {
    zip.file(path, body)
  }
  return await zip.generateAsync({ type: "uint8array" })
}

class MemoryFs implements BundleFs {
  private nodes = new Map<string, { kind: "file" | "dir"; bytes?: Uint8Array }>()
  constructor(entries: Record<string, string | Uint8Array>, root = "/bundle") {
    this.nodes.set(root, { kind: "dir" })
    for (const [rel, body] of Object.entries(entries)) {
      const parts = rel.split("/")
      let acc = root
      for (let i = 0; i < parts.length - 1; i++) {
        acc = `${acc}/${parts[i]}`
        if (!this.nodes.has(acc)) this.nodes.set(acc, { kind: "dir" })
      }
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
      this.nodes.set(`${root}/${rel}`, { kind: "file", bytes })
    }
  }
  async readDir(path: string) {
    const prefix = `${path}/`
    const direct = new Set<string>()
    for (const key of this.nodes.keys()) {
      if (!key.startsWith(prefix)) continue
      const tail = key.slice(prefix.length)
      if (!tail.includes("/")) direct.add(tail)
    }
    return Array.from(direct).map((name) => ({
      name,
      isDirectory: this.nodes.get(`${path}/${name}`)?.kind === "dir",
    }))
  }
  async readTextFile(path: string) {
    const node = this.nodes.get(path)
    if (!node || node.kind !== "file" || !node.bytes) throw new Error(`not found: ${path}`)
    return new TextDecoder("utf-8").decode(node.bytes)
  }
  async readFile(path: string) {
    const node = this.nodes.get(path)
    if (!node || node.kind !== "file" || !node.bytes) throw new Error(`not found: ${path}`)
    return node.bytes
  }
  async exists(path: string) {
    return this.nodes.has(path)
  }
}

describe("loadBundle", () => {
  it("loads a flat anthropic zip blob", async () => {
    const bytes = await buildZip({ "SKILL.md": SKILL_MD })
    const input: BundleInput = { kind: "zip-blob", bytes }
    const result = await loadBundle(input)
    expect(result.flavor).toBe("anthropic")
    expect(result.draft.name).toBe("Code Review")
    expect(result.resources).toEqual([])
    expect(result.codexMeta).toBeUndefined()
  })

  it("loads a codex zip with nested layout + resources", async () => {
    const bytes = await buildZip({
      "code-review/SKILL.md": SKILL_MD,
      "code-review/scripts/check.sh": "#!/bin/bash\n",
      "code-review/agents/openai.yaml": CODEX_OPENAI_YAML,
    })
    const result = await loadBundle({ kind: "zip-blob", bytes })
    expect(result.flavor).toBe("codex")
    expect(result.rootDirName).toBe("code-review")
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0].kind).toBe("script")
    expect(result.codexMeta?.interface?.displayName).toBe("Code Review (Codex)")
  })

  it("loads a folder via the injected fs adapter", async () => {
    const fs = new MemoryFs({
      "SKILL.md": SKILL_MD,
      "references/notes.md": "# Notes\n",
    })
    const result = await loadBundle({ kind: "folder", path: "/bundle", fs })
    expect(result.flavor).toBe("anthropic")
    expect(result.rootDirName).toBe("bundle")
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0].path).toBe("references/notes.md")
  })

  it("restores inline resource flags from portable Cognia metadata", async () => {
    const skillMd = `---
name: inline-skill
description: Loads selected references eagerly
metadata:
  cognia.inline-resources: '["references/inline.md"]'
---
Body.
`
    const bytes = await buildZip({
      "inline-skill/SKILL.md": skillMd,
      "inline-skill/references/inline.md": "Inline",
      "inline-skill/references/lazy.md": "Lazy",
    })
    const result = await loadBundle({ kind: "zip-blob", bytes })
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "references/inline.md", inline: true }),
        expect.objectContaining({ path: "references/lazy.md", inline: undefined }),
      ])
    )
  })

  it("composes walker warnings with parser warnings", async () => {
    const bytes = await buildZip({
      "SKILL.md": SKILL_MD,
      "extras/stray.txt": "stray",
    })
    const result = await loadBundle({ kind: "zip-blob", bytes })
    expect(result.warnings.some((w) => w.includes("classified as 'reference'"))).toBe(true)
  })

  it("falls back to rootDirName for fallbackName when not provided", async () => {
    const noName = `---\ndescription: x\n---\nBody.\n`
    const bytes = await buildZip({ "my-skill/SKILL.md": noName })
    const result = await loadBundle({ kind: "zip-blob", bytes })
    expect(result.draft.name).toBe("my-skill")
  })

  it("propagates fatal errors from the parser", async () => {
    const noBody = `---\nname: ok\n---\n`
    const bytes = await buildZip({ "SKILL.md": noBody })
    await expect(loadBundle({ kind: "zip-blob", bytes })).rejects.toThrow(/refused|content body/i)
  })

  it("rejects an unknown input kind at compile time and at runtime", async () => {
    // Cast through unknown so the compiler doesn't reject the bad shape —
    // we want to verify the runtime guard still fires for forward-compat.
    const bad = { kind: "telepathy" } as unknown as BundleInput
    await expect(loadBundle(bad)).rejects.toThrow(/Unknown bundle input/)
  })

  it("accepts ArrayBuffer in zip-blob inputs", async () => {
    const bytes = await buildZip({ "SKILL.md": SKILL_MD })
    const ab = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(ab).set(bytes)
    const result = await loadBundle({ kind: "zip-blob", bytes: ab })
    expect(result.draft.name).toBe("Code Review")
  })
})
