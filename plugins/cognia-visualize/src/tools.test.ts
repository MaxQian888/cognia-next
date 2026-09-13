import { createVisualizeTools, VISUALIZE_TOOL_NAMES } from "./tools"

it("exposes closed schemas for the complete Visualize tool contract", () => {
  const tools = createVisualizeTools({ pluginId: "cognia-visualize" } as never)
  expect(tools.map((tool) => tool.name)).toEqual(VISUALIZE_TOOL_NAMES)
  tools.forEach((tool) =>
    expect(tool.definition.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
  )
})

it("visualize_list delegates to the artifact API scoped to the plugin kind", async () => {
  const listArtifacts = jest.fn(() => [
    {
      id: "v1",
      title: "Revenue",
      version: 2,
      updatedAt: new Date(0),
      sessionId: "s1",
      metadata: { plugin: { kind: "cognia-visualize/visualization" } },
    },
    {
      id: "other",
      title: "Not ours",
      version: 1,
      updatedAt: new Date(0),
      sessionId: "s1",
      metadata: { plugin: { kind: "other/plugin" } },
    },
  ])
  const tools = createVisualizeTools({
    pluginId: "cognia-visualize",
    artifact: { listArtifacts },
  } as never)
  const list = tools.find((tool) => tool.name === "visualize_list")!
  await expect(list.execute({ sessionId: "s1" }, {} as never)).resolves.toEqual({
    ok: true,
    artifacts: [expect.objectContaining({ artifactId: "v1", title: "Revenue", version: 2 })],
  })
  expect(listArtifacts).toHaveBeenCalledWith({ sessionId: "s1" })
})
