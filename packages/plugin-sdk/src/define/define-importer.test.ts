import { defineImporter } from "./define-importer"

describe("defineImporter", () => {
  it("returns the importer definition unchanged (pure pass-through)", () => {
    const importFn = jest.fn(async () => ({ success: true, data: "parsed" }))
    const def = defineImporter({
      id: "markdown",
      name: "Markdown",
      description: "Import a Markdown transcript.",
      format: "markdown",
      extensions: ["md", "markdown"],
      mimeType: "text/markdown",
      import: importFn,
    })
    expect(def).toMatchObject({
      id: "markdown",
      format: "markdown",
      extensions: ["md", "markdown"],
    })
    expect(def.import).toBe(importFn)
  })

  it("supports a typed import payload", async () => {
    const def = defineImporter<{ count: number }>({
      id: "count",
      name: "Count",
      description: "counts",
      format: "count",
      extensions: ["txt"],
      import: (src) => ({ success: true, data: { count: String(src.content).length } }),
    })
    const out = await def.import({ content: "abc" })
    expect(out).toEqual({ success: true, data: { count: 3 } })
  })
})
