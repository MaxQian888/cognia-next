import type { OfficePluginContext } from "./runtime"
import type { PluginToolContext } from "@cognia/plugin-sdk"
const mockRuntime = {
  create: jest.fn(async () => ({ ok: true, artifactId: "a1" })),
  importXlsx: jest.fn(async () => ({ ok: true, artifactId: "a1" })),
  inspect: jest.fn(() => ({ ok: true, artifactId: "a1" })),
  applyOperations: jest.fn(() => ({ ok: true, artifactId: "a1", version: 2 })),
  validate: jest.fn(() => ({ ok: true, artifactId: "a1", findings: [] })),
  exportXlsx: jest.fn(async () => ({ ok: true, artifactId: "a1" })),
  syncLark: jest.fn(async () => ({ ok: true, artifactId: "a1" })),
}

jest.mock("./runtime", () => ({
  createOfficeRuntime: () => mockRuntime,
}))

import { createOfficeTools, OFFICE_TOOL_NAMES } from "./tools"

const execution = {
  sessionId: "session-1",
  messageId: "message-1",
  signal: new AbortController().signal,
  config: {},
} satisfies PluginToolContext

function context() {
  return {
    pluginId: "cognia-office",
    artifact: { openArtifact: jest.fn() },
  } as unknown as OfficePluginContext
}

beforeEach(() => {
  jest.clearAllMocks()
})

it("executes every namespaced Office tool through the runtime", async () => {
  const ctx = context()
  const tools = createOfficeTools(ctx)
  expect(tools.map((tool) => tool.name)).toEqual(OFFICE_TOOL_NAMES)
  expect(tools.every((tool) => tool.pluginId === "cognia-office")).toBe(true)

  await tools[0].execute(
    {
      title: "Workbook",
      sheetTitle: "Data",
      content: "A,B",
      operations: [{ op: "addSheet", title: "Summary" }],
    },
    execution
  )
  expect(mockRuntime.create).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "session-1", messageId: "message-1" })
  )

  await tools[1].execute({ handle: "attachment-1", title: "Imported" }, execution)
  expect(mockRuntime.importXlsx).toHaveBeenCalledWith(
    expect.objectContaining({ handle: "attachment-1", sessionId: "session-1" })
  )

  await tools[2].execute({ artifactId: "a1" }, execution)
  expect(mockRuntime.inspect).toHaveBeenCalledWith("a1")

  const operations = [
    { op: "setCell" as const, sheet: "Data", cell: "A1", value: { type: "string" as const } },
  ]
  await tools[3].execute(
    { artifactId: "a1", expectedVersion: 1, operations, changeDescription: "edit" },
    execution
  )
  expect(mockRuntime.applyOperations).toHaveBeenCalledWith({
    artifactId: "a1",
    expectedVersion: 1,
    operations,
    changeDescription: "edit",
  })

  await tools[4].execute({ artifactId: "a1" }, execution)
  expect(mockRuntime.validate).toHaveBeenCalledWith("a1")

  await tools[5].execute({ artifactId: "a1" }, execution)
  expect(ctx.artifact.openArtifact).toHaveBeenCalledWith("a1")

  await tools[6].execute(
    { artifactId: "a1", suggestedName: "workbook.xlsx", allowUnsupportedFeatureLoss: true },
    execution
  )
  expect(mockRuntime.exportXlsx).toHaveBeenCalledWith("a1", "workbook.xlsx", true)

  await tools[7].execute({ artifactId: "a1" }, execution)
  expect(mockRuntime.syncLark).toHaveBeenCalledWith("a1", "session-1", execution.signal)
})

it("requires a session before synchronizing to Lark", async () => {
  const sync = createOfficeTools(context())[7]
  await expect(sync.execute({ artifactId: "a1" }, { config: {} })).rejects.toThrow(
    "requires a chat session"
  )
  expect(mockRuntime.syncLark).not.toHaveBeenCalled()
})
