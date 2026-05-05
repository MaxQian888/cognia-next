import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createStdioTransport } from "./transport-stdio"

describe("createStdioTransport", () => {
  test("returns a fresh StdioServerTransport instance", () => {
    const transport = createStdioTransport()
    expect(transport).toBeInstanceOf(StdioServerTransport)
  })

  test("each call yields a new instance (no shared state)", () => {
    const a = createStdioTransport()
    const b = createStdioTransport()
    expect(a).not.toBe(b)
  })
})
