jest.mock("./pdf-engine", () => ({ inspectPdf: jest.fn(async () => ({ pageCount: 1 })) }))

import definition, { manifest } from "./index"
import { PDF_TOOL_NAMES } from "./tools"

it("registers the PDF renderer, importer, translations, and tools", async () => {
  const registerTool = jest.fn()
  const registerRenderer = jest.fn()
  const registerImporter = jest.fn()
  await definition.activate?.({
    pluginId: "cognia-pdf",
    artifact: { registerRenderer },
    import: { registerImporter },
    agent: { registerTool },
    i18n: { registerTranslations: jest.fn(), t: (key: string) => key },
    logger: { info: jest.fn() },
  } as never)
  expect(manifest.id).toBe("cognia-pdf")
  expect(registerRenderer).toHaveBeenCalledWith("cognia-pdf/document", expect.any(Object))
  expect(registerImporter).toHaveBeenCalledWith(expect.objectContaining({ id: "pdf" }))
  expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(PDF_TOOL_NAMES)
})
