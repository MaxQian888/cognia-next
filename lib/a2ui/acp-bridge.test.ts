/**
 * Tests for the ACP-stdout sniffer that detects A2UI server-message lines
 * and forwards them straight into the store.
 */

import { detectAndDispatchA2uiLine } from "./acp-bridge"

const processMessage = jest.fn()

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: {
    getState: () => ({ processMessage }),
  },
}))

jest.mock("@/lib/logging", () => ({
  loggers: {
    a2ui: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  },
}))

describe("detectAndDispatchA2uiLine", () => {
  beforeEach(() => {
    processMessage.mockReset()
  })

  it("returns false and skips dispatch for non-JSON lines", () => {
    expect(detectAndDispatchA2uiLine("Hello world")).toBe(false)
    expect(detectAndDispatchA2uiLine("foo: bar")).toBe(false)
    expect(processMessage).not.toHaveBeenCalled()
  })

  it("returns false for lines that don't start with `{`", () => {
    expect(detectAndDispatchA2uiLine("[1, 2, 3]")).toBe(false)
    expect(processMessage).not.toHaveBeenCalled()
  })

  it("returns false for malformed JSON", () => {
    expect(detectAndDispatchA2uiLine("{not valid json")).toBe(false)
    expect(processMessage).not.toHaveBeenCalled()
  })

  it("returns false for JSON objects with an unrelated `type`", () => {
    expect(detectAndDispatchA2uiLine(JSON.stringify({ type: "log", message: "hi" }))).toBe(false)
    expect(processMessage).not.toHaveBeenCalled()
  })

  it("dispatches a createSurface message and returns true", () => {
    const msg = {
      type: "createSurface",
      surfaceId: "sx-1",
      surfaceType: "inline",
    }
    expect(detectAndDispatchA2uiLine(JSON.stringify(msg))).toBe(true)
    expect(processMessage).toHaveBeenCalledWith(msg)
  })

  it("dispatches every supported A2UI server-message kind", () => {
    const fixtures = [
      { type: "createSurface", surfaceId: "s", surfaceType: "inline" },
      { type: "updateComponents", surfaceId: "s", components: [] },
      { type: "dataModelUpdate", surfaceId: "s", data: {} },
      { type: "deleteSurface", surfaceId: "s" },
      { type: "surfaceReady", surfaceId: "s" },
    ]
    for (const msg of fixtures) {
      processMessage.mockClear()
      expect(detectAndDispatchA2uiLine(JSON.stringify(msg))).toBe(true)
      expect(processMessage).toHaveBeenCalledWith(msg)
    }
  })

  it("tolerates surrounding whitespace", () => {
    const msg = { type: "deleteSurface", surfaceId: "sx-2" }
    expect(detectAndDispatchA2uiLine("   " + JSON.stringify(msg) + "  \n")).toBe(true)
    expect(processMessage).toHaveBeenCalledWith(msg)
  })

  it("returns false when processMessage throws (and does not propagate)", () => {
    processMessage.mockImplementationOnce(() => {
      throw new Error("boom")
    })
    const msg = { type: "surfaceReady", surfaceId: "sx" }
    expect(detectAndDispatchA2uiLine(JSON.stringify(msg))).toBe(false)
  })
})
