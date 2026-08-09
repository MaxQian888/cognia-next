jest.mock("./pptx", () => ({ importPptx: jest.fn(async () => ({ title: "Imported" })) }))
import definition, { manifest } from "./index"
import { PRESENTATION_TOOL_NAMES } from "./tools"

it("registers the complete Presentations plugin surface", async () => {
  const registerTool = jest.fn(),
    registerRenderer = jest.fn(),
    registerImporter = jest.fn()
  await definition.activate?.({
    pluginId: "cognia-presentations",
    artifact: { registerRenderer },
    import: { registerImporter },
    agent: { registerTool },
    i18n: { registerTranslations: jest.fn(), t: (key: string) => key },
    logger: { info: jest.fn() },
  } as never)
  expect(manifest.id).toBe("cognia-presentations")
  expect(registerRenderer).toHaveBeenCalledWith("cognia-presentations/deck", expect.any(Object))
  expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(PRESENTATION_TOOL_NAMES)
})
