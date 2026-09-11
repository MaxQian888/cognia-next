import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { detectFormat, viewFile, readSkillFile } from "./view-controller"
import type { TuiAction } from "../state/types"

function collect() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

describe("detectFormat", () => {
  it("renders markdown extensions as markdown", () => {
    expect(detectFormat("/x/README.md")).toEqual({ format: "markdown" })
    expect(detectFormat("/x/doc.markdown")).toEqual({ format: "markdown" })
    expect(detectFormat("/x/page.mdx")).toEqual({ format: "markdown" })
  })

  it("maps known code extensions to a highlight language", () => {
    expect(detectFormat("/x/a.ts")).toEqual({ format: "text", lang: "typescript" })
    expect(detectFormat("/x/a.rs")).toEqual({ format: "text", lang: "rust" })
    expect(detectFormat("/x/a.PY")).toEqual({ format: "text", lang: "python" })
  })

  it("falls back to plain text for unknown extensions", () => {
    expect(detectFormat("/x/LICENSE")).toEqual({ format: "text" })
    expect(detectFormat("/x/data.bin")).toEqual({ format: "text" })
  })
})

describe("viewFile", () => {
  it("rejects an empty path with usage", async () => {
    const { dispatch, actions } = collect()
    await viewFile("   ", { dispatch, cwd: "/work" })
    expect(actions).toEqual([{ type: "NOTICE", message: "Usage: /view <path>" }])
  })

  it("resolves a relative path against cwd and opens a document overlay", async () => {
    const { dispatch, actions } = collect()
    const readFile = jest.fn().mockResolvedValue("# Title\n\nbody")
    await viewFile("docs/readme.md", { dispatch, cwd: "/work", readFile })
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining("readme.md"))
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", body: "# Title\n\nbody" },
    })
    // Title is the cwd-relative path.
    expect((actions[0] as { overlay: { title: string } }).overlay.title).toMatch(/readme\.md$/)
  })

  it("passes through an absolute path untouched and infers the language", async () => {
    const { dispatch, actions } = collect()
    const readFile = jest.fn().mockResolvedValue("const x = 1")
    await viewFile("/abs/main.ts", { dispatch, cwd: "/work", readFile })
    expect(readFile).toHaveBeenCalledWith("/abs/main.ts")
    expect(actions[0]).toMatchObject({
      overlay: { kind: "document", format: "text", lang: "typescript" },
    })
  })

  it("surfaces a read error as a notice", async () => {
    const { dispatch, actions } = collect()
    const readFile = jest.fn().mockRejectedValue(new Error("ENOENT"))
    await viewFile("missing.txt", { dispatch, cwd: "/work", readFile })
    expect(actions).toEqual([{ type: "NOTICE", message: "Cannot read missing.txt: ENOENT" }])
  })

  it("truncates a body larger than maxBytes and notes it", async () => {
    const { dispatch, actions } = collect()
    const big = "x".repeat(500)
    const readFile = jest.fn().mockResolvedValue(big)
    await viewFile("big.txt", { dispatch, cwd: "/work", readFile, maxBytes: 100 })
    const body = (actions[0] as { overlay: { body: string } }).overlay.body
    expect(body).toContain("truncated at")
    expect(body.length).toBeLessThan(big.length)
  })
})

describe("readSkillFile", () => {
  it("previews nested text and bounds large files, while rejecting binary and escaping symlinks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-preview-"))
    const root = path.join(dir, "skill")
    await fs.mkdir(path.join(root, "refs"), { recursive: true })
    try {
      const file = path.join(root, "refs", "guide.md")
      await fs.writeFile(file, "# Nested guide")
      expect(await readSkillFile(root, file)).toEqual({
        format: "markdown",
        body: "# Nested guide",
      })
      const large = path.join(root, "large.txt")
      await fs.writeFile(large, "x".repeat(300000))
      const preview = await readSkillFile(root, large)
      expect(preview.body.length).toBeLessThan(263000)
      expect(preview.body).toContain("truncated at 256 KB")
      const binary = path.join(root, "binary.bin")
      await fs.writeFile(binary, Buffer.from([1, 0, 2]))
      await expect(readSkillFile(root, binary)).rejects.toThrow("Binary file")
      const outside = path.join(dir, "outside.txt")
      await fs.writeFile(outside, "outside")
      const link = path.join(root, "link.txt")
      await fs.symlink(outside, link)
      await expect(readSkillFile(root, link)).rejects.toThrow("outside the skill directory")
      await expect(readSkillFile(root, root)).rejects.toThrow("Not a regular file")
      await expect(readSkillFile(root, path.join(root, "missing"))).rejects.toThrow()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

it("bounds UTF-8 bytes without splitting Chinese characters", async () => {
  const { dispatch, actions } = collect()
  await viewFile("中文.txt", {
    dispatch,
    cwd: "/work",
    readFile: async () => "你好世界",
    maxBytes: 7,
    locale: "zh-CN",
  })
  expect(actions[0]).toMatchObject({ overlay: { body: expect.stringContaining("你好\n") } })
  const body = (actions[0] as { overlay: { body: string } }).overlay.body
  expect(body).not.toContain("世")
  expect(body).not.toContain("�")
  expect(body).toContain("截断")
})

it("reads real files with a bounded handle and rejects directories and binary content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "view-bounded-"))
  const readSpy = jest.spyOn(fs, "readFile")
  try {
    await fs.writeFile(path.join(dir, "large.txt"), "中".repeat(100000))
    await fs.writeFile(path.join(dir, "binary.dat"), Buffer.from([0, 1, 2]))
    const result = collect()
    await viewFile('"large.txt"', { ...result, cwd: dir, maxBytes: 8 })
    expect(result.actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { body: expect.stringContaining("中中\n") },
    })
    expect(readSpy).not.toHaveBeenCalled()
    for (const name of ["binary.dat", "."]) {
      const rejected = collect()
      await viewFile(name, { ...rejected, cwd: dir, locale: "zh-CN" })
      expect(rejected.actions[0]).toMatchObject({ type: "NOTICE" })
      expect(JSON.stringify(rejected.actions[0])).toContain(name === "." ? "普通文件" : "二进制")
    }
  } finally {
    readSpy.mockRestore()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

it("resolves quoted home paths without executing shell syntax", async () => {
  const result = collect()
  const readFile = jest.fn().mockResolvedValue("literal")
  await viewFile("'~/a b.txt'", { ...result, cwd: "/work", readFile, maxBytes: -1 })
  expect(readFile).toHaveBeenCalledWith(path.join(os.homedir(), "a b.txt"))
  expect(result.actions[0]).toMatchObject({ overlay: { body: "literal" } })
})
