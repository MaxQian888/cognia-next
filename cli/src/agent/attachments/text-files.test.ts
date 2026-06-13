/**
 * @jest-environment node
 */
import nodeFs from "node:fs"
import nodeOs from "node:os"
import nodePath from "node:path"

import { readTextFileBlock, MAX_TEXT_INJECT_BYTES } from "./text-files"

const deps = (files: Record<string, string>) => ({
  readFileUtf8: (p: string) => {
    const key = Object.keys(files).find((k) => p.replace(/\\/g, "/").endsWith(k))
    if (!key) throw new Error("ENOENT")
    return files[key]
  },
  isFile: (p: string) => Object.keys(files).some((k) => p.replace(/\\/g, "/").endsWith(k)),
})

describe("readTextFileBlock", () => {
  it("wraps file content in a <file> block", () => {
    const d = deps({ "main.ts": "export const x = 1\n" })
    expect(readTextFileBlock("main.ts", "/w", d)).toEqual({
      ok: true,
      text: '<file path="main.ts">\nexport const x = 1\n\n</file>',
    })
  })

  it("reports failure for a missing file", () => {
    expect(readTextFileBlock("nope.md", "/w", deps({}))).toEqual({ ok: false })
  })

  it("reports failure when the reader throws on an existing file", () => {
    const r = readTextFileBlock("x.txt", "/w", {
      isFile: () => true,
      readFileUtf8: () => {
        throw new Error("EIO")
      },
    })
    expect(r).toEqual({ ok: false })
  })

  it("truncates content over the cap with a marker", () => {
    const big = "a".repeat(MAX_TEXT_INJECT_BYTES + 10)
    const d = deps({ "big.log": big })
    const r = readTextFileBlock("big.log", "/w", d)
    expect(r.ok).toBe(true)
    expect(r.ok && r.text.includes("[truncated 10 bytes]")).toBe(true)
    expect(r.ok && r.text.length).toBeLessThan(big.length + 100)
  })

  it("reads a real file and reports a real missing file via default fs", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "tf-"))
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "r.txt"), "hello")
      expect(readTextFileBlock("r.txt", dir)).toEqual({
        ok: true,
        text: '<file path="r.txt">\nhello\n</file>',
      })
      expect(readTextFileBlock("missing.txt", dir)).toEqual({ ok: false })
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
