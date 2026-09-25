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
  // Omitted sessionId → the calling session; allSessions → no filter.
  await list.execute({}, { sessionId: "s-call", config: {} })
  expect(listArtifacts).toHaveBeenLastCalledWith({ sessionId: "s-call" })
  await list.execute({ allSessions: true }, { sessionId: "s-call", config: {} })
  expect(listArtifacts).toHaveBeenLastCalledWith(undefined)
})

it("constrains profile to the real renderer set and budgets file-saving tools", () => {
  const tools = createVisualizeTools({ pluginId: "cognia-visualize" } as never)
  const create = tools.find((tool) => tool.name === "visualize_create")!
  const profile = (
    create.definition.parametersSchema as { properties: { profile: { enum: string[] } } }
  ).properties.profile
  expect(profile.enum).toHaveLength(19)
  expect(profile.enum).not.toEqual(expect.arrayContaining(["map"]))
  const timeouts = Object.fromEntries(tools.map((tool) => [tool.name, tool.definition.timeoutMs]))
  expect(timeouts).toMatchObject({ visualize_export: 120_000, visualize_export_report: 120_000 })
})

it("visualize_export_report reports the calling session through the export pipeline", async () => {
  const exportSession = jest.fn(async () => ({ success: false, error: "Session not found" }))
  const tools = createVisualizeTools({
    artifact: {
      listArtifacts: jest.fn(() => [
        { id: "v1", metadata: { plugin: { kind: "cognia-visualize/visualization" } } },
      ]),
    },
    export: { exportSession },
    i18n: { t: (key: string) => key },
  } as never)
  const report = tools.find((tool) => tool.name === "visualize_export_report")!
  await expect(report.execute({}, { config: {} })).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("pass sessionId"),
  })
  await expect(report.execute({}, { sessionId: "s9", config: {} })).resolves.toMatchObject({
    ok: false,
    error: "Session not found",
  })
  expect(exportSession).toHaveBeenCalledWith("s9", { format: "visualization-report" })
})
