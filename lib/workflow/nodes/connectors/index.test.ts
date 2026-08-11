import "."
import { getExecutor } from "../registry"

describe("connector-nodes registration", () => {
  it.each([
    ["action.connector.delete", 1],
    ["action.connector.draft", 1],
    ["action.connector.forward", 1],
    ["action.connector.reaction", 1],
    ["action.connector.send", 1],
    ["action.connector.waitReply", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
