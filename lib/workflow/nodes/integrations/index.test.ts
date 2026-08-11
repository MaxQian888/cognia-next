import "."
import { getExecutor } from "../registry"

describe("integration-nodes registration", () => {
  it.each([
    ["action.mcp.invokeTool", 1],
    ["action.memory.recall", 1],
    ["action.memory.store", 1],
    ["action.plugin.invoke", 1],
    ["action.skill.invoke", 1],
    ["action.skill.upsert", 1],
    ["action.twin.ingest", 1],
    ["action.twin.rag", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
