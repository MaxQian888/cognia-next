/**
 * @jest-environment node
 */

import { logParser } from "./log-parser"

describe("logParser", () => {
  it("parses single line per level", () => {
    const text = `ERROR: something failed
WARN: watch out
INFO: all good
DEBUG: detail here
TRACE: very detail`

    const result = logParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(5)
    expect(result!.nodes[0].level).toBe("error")
    expect(result!.nodes[1].level).toBe("warn")
    expect(result!.nodes[2].level).toBe("info")
    expect(result!.nodes[3].level).toBe("debug")
    expect(result!.nodes[4].level).toBe("trace")
  })

  it("inherits level for multi-line content", () => {
    const text = `ERROR: something failed
    at /app/server.js:42
    at /app/lib/request.ts:15`

    const result = logParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(3)
    expect(result!.nodes[0].level).toBe("error")
    expect(result!.nodes[1].level).toBe("error")
    expect(result!.nodes[2].level).toBe("error")
  })

  it("returns null when no level matches", () => {
    const result = logParser.parse("just some plain text")
    expect(result).toBeNull()
  })

  it("is case-insensitive", () => {
    const result = logParser.parse("error: lowercase\nERROR: uppercase\nError: mixed")
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(3)
    expect(result!.nodes[0].level).toBe("error")
    expect(result!.nodes[1].level).toBe("error")
    expect(result!.nodes[2].level).toBe("error")
  })

  it("returns null for empty string", () => {
    expect(logParser.parse("")).toBeNull()
  })
})
