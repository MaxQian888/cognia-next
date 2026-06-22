import { defineExporter } from "./define-exporter"

describe("defineExporter", () => {
  it("returns the exporter definition unchanged (pure pass-through)", () => {
    const exportFn = jest.fn(async () => "# Hello")
    const e = defineExporter({
      id: "markdown-plus",
      name: "Markdown+",
      description: "Markdown with front-matter.",
      format: "markdown-plus",
      extension: "md",
      mimeType: "text/markdown",
      export: exportFn,
    })
    expect(e).toMatchObject({
      id: "markdown-plus",
      name: "Markdown+",
      format: "markdown-plus",
      extension: "md",
      mimeType: "text/markdown",
    })
    expect(e.export).toBe(exportFn)
  })

  it("supports a Blob-returning exporter", async () => {
    const e = defineExporter({
      id: "bin",
      name: "Binary",
      description: "binary blob",
      format: "bin",
      extension: "bin",
      mimeType: "application/octet-stream",
      export: async () => new Blob(["x"]),
    })
    const out = await e.export({ exportedAt: new Date(0) })
    expect(out).toBeInstanceOf(Blob)
  })
})
