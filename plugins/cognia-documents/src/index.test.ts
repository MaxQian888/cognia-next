jest.mock("./docx", () => ({ importDocx: jest.fn(async () => ({ title: "Imported" })) }))
import definition, { manifest } from "./index"
import { DOCUMENT_TOOL_NAMES } from "./tools"

it("registers the complete Documents plugin surface", async () => {
  const registerTool = jest.fn(),
    registerRenderer = jest.fn(),
    registerImporter = jest.fn()
  await definition.activate?.({
    pluginId: "cognia-documents",
    artifact: { registerRenderer },
    import: { registerImporter },
    agent: { registerTool },
    i18n: { registerTranslations: jest.fn(), t: (key: string) => key },
    logger: { info: jest.fn() },
  } as never)
  expect(manifest.id).toBe("cognia-documents")
  expect(registerRenderer).toHaveBeenCalledWith("cognia-documents/document", expect.any(Object))
  expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(DOCUMENT_TOOL_NAMES)
})
