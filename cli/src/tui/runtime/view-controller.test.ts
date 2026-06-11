import { detectFormat, viewFile } from "./view-controller"
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
