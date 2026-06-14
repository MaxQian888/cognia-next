import { createImportAPI, clearCustomImporters } from "./import-api"

jest.mock("../core/logger", () => ({
  createPluginSystemLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}))

describe("createImportAPI", () => {
  beforeEach(() => clearCustomImporters())

  it("registers an importer namespaced by plugin id and lists it", () => {
    const api = createImportAPI("p1")
    api.registerImporter({
      id: "md",
      name: "Markdown",
      description: "md",
      format: "markdown",
      extensions: ["md"],
      import: () => ({ success: true }),
    })
    const all = api.getCustomImporters()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe("p1:md")
  })

  it("disposer unregisters the importer", () => {
    const api = createImportAPI("p1")
    const dispose = api.registerImporter({
      id: "md",
      name: "Markdown",
      description: "md",
      format: "markdown",
      extensions: ["md"],
      import: () => ({ success: true }),
    })
    dispose()
    expect(api.getCustomImporters()).toHaveLength(0)
  })

  it("importContent dispatches to the importer registered for the format", async () => {
    const api = createImportAPI("p1")
    api.registerImporter({
      id: "md",
      name: "Markdown",
      description: "md",
      format: "markdown",
      extensions: ["md"],
      import: (src) => ({ success: true, data: String(src.content).toUpperCase() }),
    })
    const result = await api.importContent({ content: "hi" }, "markdown")
    expect(result).toEqual({ success: true, data: "HI" })
  })

  it("importContent returns an error when no importer matches the format", async () => {
    const api = createImportAPI("p1")
    const result = await api.importContent({ content: "x" }, "nope")
    expect(result.success).toBe(false)
    expect(result.error).toContain("nope")
  })

  it("importContent surfaces a throwing importer as a failure result", async () => {
    const api = createImportAPI("p1")
    api.registerImporter({
      id: "boom",
      name: "Boom",
      description: "throws",
      format: "boom",
      extensions: ["x"],
      import: () => {
        throw new Error("kaboom")
      },
    })
    const result = await api.importContent({ content: "x" }, "boom")
    expect(result).toEqual({ success: false, error: "kaboom" })
  })

  it("isolates importers across plugins by namespacing", () => {
    const a = createImportAPI("a")
    const b = createImportAPI("b")
    a.registerImporter({
      id: "same",
      name: "A",
      description: "a",
      format: "fa",
      extensions: ["x"],
      import: () => ({ success: true }),
    })
    b.registerImporter({
      id: "same",
      name: "B",
      description: "b",
      format: "fb",
      extensions: ["x"],
      import: () => ({ success: true }),
    })
    expect(
      a
        .getCustomImporters()
        .map((i) => i.id)
        .sort()
    ).toEqual(["a:same", "b:same"])
  })
})
