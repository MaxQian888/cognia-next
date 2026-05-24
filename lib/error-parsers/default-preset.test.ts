/**
 * @jest-environment node
 */

import { defaultPreset } from "./default-preset"

describe("defaultPreset", () => {
  it("parses pure JSON", () => {
    const result = defaultPreset.parse('{"key": "value"}')
    expect(result.parsed).toBe(true)
    expect(result.nodes[0].kind).toBe("json")
  })

  it("parses pure log lines", () => {
    const result = defaultPreset.parse("ERROR: something failed")
    expect(result.parsed).toBe(true)
    expect(result.nodes[0].kind).toBe("log")
    expect(result.nodes[0].level).toBe("error")
  })

  it("parses pure stack trace", () => {
    const result = defaultPreset.parse("Error: fail\n    at handler (/app/server.js:42:9)")
    expect(result.parsed).toBe(true)
    expect(result.nodes.some((n) => n.kind === "stack")).toBe(true)
  })

  it("parses mixed log + paths", () => {
    const result = defaultPreset.parse("ERROR: failed at src/foo.ts:42:9")
    expect(result.parsed).toBe(true)
    expect(result.nodes.some((n) => n.kind === "log")).toBe(true)
    expect(result.nodes.some((n) => n.kind === "path")).toBe(true)
  })

  it("returns parsed:false for plain text with no matches", () => {
    const result = defaultPreset.parse("just some plain text")
    expect(result.parsed).toBe(false)
    expect(result.nodes[0].kind).toBe("text")
  })

  it("parses empty string as identity", () => {
    const result = defaultPreset.parse("")
    expect(result.parsed).toBe(false)
    expect(result.nodes[0].content).toBe("")
  })
})
