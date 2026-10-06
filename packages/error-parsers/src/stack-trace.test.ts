/**
 * @jest-environment node
 */

import { parseStackTrace } from "./stack-trace"

describe("parseStackTrace", () => {
  it("parses Chrome/V8 style frames", () => {
    const stack = `Error: something failed
    at handler (/app/server.js:42:9)
    at processRequest (/app/lib/request.ts:15:3)`

    const frames = parseStackTrace(stack)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ fn: "handler", file: "/app/server.js", line: 42, col: 9 })
    expect(frames[1]).toEqual({
      fn: "processRequest",
      file: "/app/lib/request.ts",
      line: 15,
      col: 3,
    })
  })

  it("parses anonymous V8 frames", () => {
    const stack = `    at /app/index.js:10:5`
    const frames = parseStackTrace(stack)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ fn: "<anonymous>", file: "/app/index.js", line: 10, col: 5 })
  })

  it("parses Firefox style frames", () => {
    const stack = `handler@/app/server.js:42:9
processRequest@/app/lib/request.ts:15:3`

    const frames = parseStackTrace(stack)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ fn: "handler", file: "/app/server.js", line: 42, col: 9 })
    expect(frames[1]).toEqual({
      fn: "processRequest",
      file: "/app/lib/request.ts",
      line: 15,
      col: 3,
    })
  })

  it("returns empty array for non-stack text", () => {
    const frames = parseStackTrace("just some error message")
    expect(frames).toHaveLength(0)
  })

  it("handles mixed Chrome + Firefox frames", () => {
    const stack = `Error: mixed
    at handler (/app/server.js:42:9)
innerFn@/app/lib/request.ts:15:3`

    const frames = parseStackTrace(stack)
    expect(frames).toHaveLength(2)
    expect(frames[0].fn).toBe("handler")
    expect(frames[1].fn).toBe("innerFn")
  })
})
