import JSZip from "jszip"
import { readBundleArchive } from "./walk-zip"
import { MAX_RESOURCES_PER_SKILL, MAX_RESOURCE_BYTES_WEB } from "./limits"

const SKILL_MD = `---
name: Code Review
description: Reviews code
---
Body.
`

const OPENAI_YAML = `interface:
  display_name: Code Review
`

async function buildZip(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, body] of Object.entries(entries)) {
    zip.file(path, body)
  }
  return await zip.generateAsync({ type: "uint8array" })
}

describe("readBundleArchive", () => {
  it("parses a flat anthropic minimal bundle", async () => {
    const bytes = await buildZip({ "SKILL.md": SKILL_MD })
    const result = await readBundleArchive(bytes)
    expect(result.skillMd).toBe(SKILL_MD)
    expect(result.resources).toEqual([])
    expect(result.openaiYaml).toBeUndefined()
    expect(result.rootDirName).toBeUndefined()
    expect(result.warnings).toEqual([])
  })

  it("parses a single-nested bundle (<name>/SKILL.md)", async () => {
    const bytes = await buildZip({
      "code-review/SKILL.md": SKILL_MD,
      "code-review/scripts/check.sh": "#!/bin/bash\necho ok\n",
      "code-review/references/notes.md": "# Notes\n",
      "code-review/assets/icon.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    const result = await readBundleArchive(bytes)
    expect(result.rootDirName).toBe("code-review")
    expect(result.resources).toHaveLength(3)
    const byPath = Object.fromEntries(result.resources.map((r) => [r.path, r]))
    expect(byPath["scripts/check.sh"].kind).toBe("script")
    expect(byPath["scripts/check.sh"].encoding).toBe("utf-8")
    expect(byPath["references/notes.md"].kind).toBe("reference")
    expect(byPath["assets/icon.png"].kind).toBe("asset")
    expect(byPath["assets/icon.png"].encoding).toBe("base64")
  })

  it("picks up agents/openai.yaml and excludes it from resources", async () => {
    const bytes = await buildZip({
      "SKILL.md": SKILL_MD,
      "agents/openai.yaml": OPENAI_YAML,
    })
    const result = await readBundleArchive(bytes)
    expect(result.openaiYaml).toBe(OPENAI_YAML)
    expect(result.resources).toEqual([])
  })

  it("warns about resources outside scripts/references/assets but keeps them as `asset`", async () => {
    const bytes = await buildZip({
      "SKILL.md": SKILL_MD,
      "extras/extra.txt": "hello",
    })
    const result = await readBundleArchive(bytes)
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0].kind).toBe("asset")
    expect(result.warnings.some((w) => w.includes("classified as 'asset'"))).toBe(true)
  })

  it("rejects a bundle that is missing SKILL.md", async () => {
    const bytes = await buildZip({ "README.md": "no skill here" })
    await expect(readBundleArchive(bytes)).rejects.toThrow(/missing SKILL.md/)
  })

  it("rejects absolute-path resources (defense-in-depth, JSZip preserves leading slashes)", async () => {
    // JSZip normalises `..` segments out of zip entry paths, so a true
    // traversal attempt never reaches our validator. The walker's
    // defense-in-depth still matters because JSZip *does* preserve leading
    // slashes — that's the case we exercise here.
    const bytes = await buildZip({
      "SKILL.md": SKILL_MD,
      "/etc/passwd": "x",
    })
    await expect(readBundleArchive(bytes)).rejects.toThrow(/absolute path/)
  })

  it("rejects an over-cap resource", async () => {
    const big = new Uint8Array(MAX_RESOURCE_BYTES_WEB + 1)
    const bytes = await buildZip({
      "SKILL.md": SKILL_MD,
      "assets/huge.bin": big,
    })
    await expect(readBundleArchive(bytes)).rejects.toThrow(/per-file cap/)
  })

  it("stops collecting after MAX_RESOURCES_PER_SKILL and warns", async () => {
    const entries: Record<string, string> = { "SKILL.md": SKILL_MD }
    for (let i = 0; i < MAX_RESOURCES_PER_SKILL + 5; i++) {
      entries[`references/note-${String(i).padStart(3, "0")}.md`] = `note ${i}\n`
    }
    const bytes = await buildZip(entries)
    const result = await readBundleArchive(bytes)
    expect(result.resources).toHaveLength(MAX_RESOURCES_PER_SKILL)
    expect(result.warnings.some((w) => w.includes("more than"))).toBe(true)
  })

  it("rejects a malformed zip blob", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4])
    await expect(readBundleArchive(bytes)).rejects.toThrow(/Failed to read/)
  })

  it("rejects bundles with multiple SKILL.md at different depths", async () => {
    const bytes = await buildZip({
      "SKILL.md": SKILL_MD,
      "extra/SKILL.md": SKILL_MD,
    })
    await expect(readBundleArchive(bytes)).rejects.toThrow(/different depths/)
  })

  it("accepts ArrayBuffer input as well as Uint8Array", async () => {
    const bytes = await buildZip({ "SKILL.md": SKILL_MD })
    // Slice into a fresh ArrayBuffer to avoid SharedArrayBuffer narrowing.
    const ab = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(ab).set(bytes)
    const result = await readBundleArchive(ab)
    expect(result.skillMd).toBe(SKILL_MD)
  })
})
