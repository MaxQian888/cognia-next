/** @jest-environment node */
import { assertCodebuffNoNativeMcp, parseBridgeFrame } from "./bridge-protocol"

describe("Codebuff bridge boundary", () => {
  it("rejects unbounded, malformed and unknown frames", () => {
    expect(() => parseBridgeFrame("{")).toThrow(/JSON/)
    expect(() => parseBridgeFrame(JSON.stringify({ type: "unknown" }))).toThrow(/Unsupported/)
    expect(() => parseBridgeFrame(" ".repeat(2 * 1024 * 1024))).toThrow(/limit/)
  })
  it("retains a native SDK event and its turn identifier", () => {
    const frame = { type: "event", turnId: "r", event: { type: "text", text: "hello" } }
    expect(parseBridgeFrame(JSON.stringify(frame))).toEqual(frame)
  })
  it("rejects MCP in nested templates and resumed SDK state", () => {
    expect(() =>
      assertCodebuffNoNativeMcp({
        data: { templates: [{ mcpServers: { unsafe: { command: "node" } } }] },
      })
    ).toThrow(/MCP/)
    expect(() =>
      assertCodebuffNoNativeMcp({
        sessionState: { nested: { mcpConfig: { url: "https://example.com" } } },
      })
    ).toThrow(/MCP/)
    expect(() => assertCodebuffNoNativeMcp({ data: { mcpServers: {} } })).not.toThrow()
  })
})
