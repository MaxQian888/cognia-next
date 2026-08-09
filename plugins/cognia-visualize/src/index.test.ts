import definition, { manifest } from "./index"
import { VISUALIZE_TOOL_NAMES } from "./tools"

it("registers Visualize entirely through the plugin contract", async () => {
  const registerTool = jest.fn(),
    registerRenderer = jest.fn()
  await definition.activate?.({
    pluginId: "cognia-visualize",
    artifact: { registerRenderer },
    agent: { registerTool },
    i18n: { registerTranslations: jest.fn(), t: (key: string) => key },
    logger: { info: jest.fn() },
  } as never)
  expect(manifest.id).toBe("cognia-visualize")
  expect(registerRenderer).toHaveBeenCalledWith(
    "cognia-visualize/visualization",
    expect.any(Object)
  )
  expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(VISUALIZE_TOOL_NAMES)
})
