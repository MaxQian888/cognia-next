import { copyMarkdown, type CopyMarkdownDeps } from "./copy-markdown"

function deps(overrides: Partial<CopyMarkdownDeps> = {}): CopyMarkdownDeps {
  return {
    fetch: async () => ({ ok: true, text: async () => "# Page\n\nBody." }),
    writeText: async () => undefined,
    ...overrides,
  }
}

describe("copyMarkdown", () => {
  it("copies the fetched Markdown", async () => {
    const written: string[] = []
    const result = await copyMarkdown(
      "/md/en/index.md",
      deps({
        writeText: async (value) => {
          written.push(value)
        },
      })
    )

    expect(result).toBe("copied")
    expect(written).toEqual(["# Page\n\nBody."])
  })

  it("requests the href it was given", async () => {
    const requested: string[] = []
    await copyMarkdown(
      "/md/zh/subsystems/ocr.md",
      deps({
        fetch: async (input) => {
          requested.push(input)
          return { ok: true, text: async () => "content" }
        },
      })
    )

    expect(requested).toEqual(["/md/zh/subsystems/ocr.md"])
  })

  it("fails when the Markdown twin is missing", async () => {
    const result = await copyMarkdown(
      "/md/en/typo.md",
      deps({
        fetch: async () => ({ ok: false, text: async () => "Not found" }),
      })
    )
    expect(result).toBe("failed")
  })

  it("fails rather than copying an empty document", async () => {
    const result = await copyMarkdown(
      "/md/en/index.md",
      deps({
        fetch: async () => ({ ok: true, text: async () => "   \n  " }),
      })
    )
    expect(result).toBe("failed")
  })

  it("fails when the network request throws", async () => {
    const result = await copyMarkdown(
      "/md/en/index.md",
      deps({
        fetch: async () => {
          throw new Error("offline")
        },
      })
    )
    expect(result).toBe("failed")
  })

  it("fails when the clipboard is unavailable, e.g. an insecure origin", async () => {
    const result = await copyMarkdown(
      "/md/en/index.md",
      deps({
        writeText: async () => {
          throw new Error("NotAllowedError")
        },
      })
    )
    expect(result).toBe("failed")
  })
})
