/**
 * @jest-environment node
 */

import { stackTraceParser } from "./stack-trace-parser"

describe("stackTraceParser", () => {
  it("parses a Chrome/V8 stack trace", () => {
    const text = `Error: something failed
    at handler (/app/server.js:42:9)
    at processRequest (/app/lib/request.ts:15:3)`

    const result = stackTraceParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0].kind).toBe("text")
    expect(result!.nodes[1].kind).toBe("stack")
    expect(result!.nodes[1].frames).toHaveLength(2)
  })

  it("parses a Firefox stack trace", () => {
    const text = `Error: something failed
handler@/app/server.js:42:9
processRequest@/app/lib/request.ts:15:3`

    const result = stackTraceParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.nodes[0].kind).toBe("stack")
    expect(result!.nodes[0].frames).toHaveLength(2)
  })

  it("returns null for non-stack text", () => {
    const result = stackTraceParser.parse("just some error message")
    expect(result).toBeNull()
  })

  it("returns null for text without 'at' or 'Error:'", () => {
    const result = stackTraceParser.parse("some warning: be careful")
    expect(result).toBeNull()
  })
})
