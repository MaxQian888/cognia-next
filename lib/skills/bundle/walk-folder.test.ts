import { readBundleFolder, type BundleFs } from "./walk-folder"
import { MAX_RESOURCES_PER_SKILL, MAX_RESOURCE_BYTES_WEB } from "./limits"

interface FakeNode {
  kind: "file" | "dir"
  bytes?: Uint8Array
}

class FakeFs implements BundleFs {
  private nodes = new Map<string, FakeNode>()

  static fromObject(entries: Record<string, string | Uint8Array>, root = "/bundle"): FakeFs {
    const fs = new FakeFs()
    fs.nodes.set(root, { kind: "dir" })
    for (const [rel, body] of Object.entries(entries)) {
      const parts = rel.split("/")
      let acc = root
      for (let i = 0; i < parts.length - 1; i++) {
        acc = `${acc}/${parts[i]}`
        if (!fs.nodes.has(acc)) fs.nodes.set(acc, { kind: "dir" })
      }
      const filePath = `${root}/${rel}`
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
      fs.nodes.set(filePath, { kind: "file", bytes })
    }
    return fs
  }

  async readDir(path: string) {
    const prefix = `${path}/`
    const direct = new Set<string>()
    for (const key of this.nodes.keys()) {
      if (!key.startsWith(prefix)) continue
      const tail = key.slice(prefix.length)
      if (!tail.includes("/")) {
        direct.add(tail)
      }
    }
    const out = Array.from(direct).map((name) => {
      const node = this.nodes.get(`${path}/${name}`)
      return { name, isDirectory: node?.kind === "dir" }
    })
    return out
  }

  async readTextFile(path: string) {
    const node = this.nodes.get(path)
    if (!node || node.kind !== "file" || !node.bytes) {
      throw new Error(`fake fs: not found ${path}`)
    }
    return new TextDecoder("utf-8").decode(node.bytes)
  }

  async readFile(path: string) {
    const node = this.nodes.get(path)
    if (!node || node.kind !== "file" || !node.bytes) {
      throw new Error(`fake fs: not found ${path}`)
    }
    return node.bytes
  }

  async exists(path: string) {
    return this.nodes.has(path)
  }
}

const SKILL_MD = `---\nname: Code Review\n---\nBody.\n`
const OPENAI_YAML = `interface:\n  display_name: Foo\n`

describe("readBundleFolder", () => {
  it("reads SKILL.md + scripts/references/assets recursively", async () => {
    const fs = FakeFs.fromObject({
      "SKILL.md": SKILL_MD,
      "scripts/check.sh": "#!/bin/bash\necho ok\n",
      "references/notes.md": "# Notes\n",
      "references/sub/extra.md": "# Sub\n",
      "assets/icon.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    const result = await readBundleFolder("/bundle", fs)
    expect(result.skillMd).toBe(SKILL_MD)
    expect(result.openaiYaml).toBeUndefined()
    expect(result.rootDirName).toBe("bundle")
    expect(result.resources).toHaveLength(4)
    const byPath = Object.fromEntries(result.resources.map((r) => [r.path, r]))
    expect(byPath["scripts/check.sh"].kind).toBe("script")
    expect(byPath["references/sub/extra.md"].kind).toBe("reference")
    expect(byPath["assets/icon.png"].encoding).toBe("base64")
  })

  it("picks up agents/openai.yaml when present", async () => {
    const fs = FakeFs.fromObject({
      "SKILL.md": SKILL_MD,
      "agents/openai.yaml": OPENAI_YAML,
    })
    const result = await readBundleFolder("/bundle", fs)
    expect(result.openaiYaml).toBe(OPENAI_YAML)
    expect(result.resources).toEqual([])
  })

  it("throws when SKILL.md is missing", async () => {
    const fs = FakeFs.fromObject({ "README.md": "no skill" })
    await expect(readBundleFolder("/bundle", fs)).rejects.toThrow(/missing SKILL.md/)
  })

  it("rejects resources that exceed the per-file cap", async () => {
    const big = new Uint8Array(MAX_RESOURCE_BYTES_WEB + 1)
    const fs = FakeFs.fromObject({
      "SKILL.md": SKILL_MD,
      "assets/huge.bin": big,
    })
    await expect(readBundleFolder("/bundle", fs)).rejects.toThrow(/per-file cap/)
  })

  it("stops collecting after MAX_RESOURCES_PER_SKILL and warns", async () => {
    const obj: Record<string, string> = { "SKILL.md": SKILL_MD }
    for (let i = 0; i < MAX_RESOURCES_PER_SKILL + 5; i++) {
      obj[`references/note-${String(i).padStart(3, "0")}.md`] = `n ${i}\n`
    }
    const fs = FakeFs.fromObject(obj)
    const result = await readBundleFolder("/bundle", fs)
    expect(result.resources.length).toBeLessThanOrEqual(MAX_RESOURCES_PER_SKILL)
    expect(result.warnings.some((w) => w.includes("more than"))).toBe(true)
  })

  it("collects root files that aren't SKILL.md, classifying them per-extension", async () => {
    const fs = FakeFs.fromObject({
      "SKILL.md": SKILL_MD,
      "README.md": "# Read me\n",
    })
    const result = await readBundleFolder("/bundle", fs)
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0].path).toBe("README.md")
    expect(result.resources[0].kind).toBe("reference")
    expect(result.warnings.some((w) => w.includes("classified as 'reference'"))).toBe(true)
  })

  it("recurses into unknown top-level subdirs and collects their contents", async () => {
    const fs = FakeFs.fromObject({
      "SKILL.md": SKILL_MD,
      "extras/stuff.txt": "hi",
    })
    const result = await readBundleFolder("/bundle", fs)
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0].path).toBe("extras/stuff.txt")
    expect(result.resources[0].kind).toBe("reference")
    expect(result.warnings.some((w) => w.includes("extras/stuff.txt"))).toBe(true)
  })

  it("collects a Claude Code `resources/` dir, classifying each file by extension", async () => {
    const fs = FakeFs.fromObject({
      "SKILL.md": SKILL_MD,
      "resources/guide.md": "# Guide\n",
      "resources/helper.py": "print('hi')\n",
      "resources/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    const result = await readBundleFolder("/bundle", fs)
    expect(result.resources).toHaveLength(3)
    const byPath = Object.fromEntries(result.resources.map((r) => [r.path, r]))
    expect(byPath["resources/guide.md"].kind).toBe("reference")
    expect(byPath["resources/helper.py"].kind).toBe("script")
    expect(byPath["resources/logo.png"].kind).toBe("asset")
    expect(byPath["resources/logo.png"].encoding).toBe("base64")
  })
})
