/**
 * @jest-environment node
 */
import {
  COGNIA_PLUGIN_TOOLS_SERVER,
  COGNIA_TOOLS_SERVER,
  TOOL_HOST_ENV,
  decodeLines,
  encodeLine,
} from "./protocol"

describe("NDJSON framing", () => {
  it("round-trips a request", () => {
    const line = encodeLine({ id: 1, method: "authorize", params: { name: "read" } })
    expect(line.endsWith("\n")).toBe(true)
    expect(decodeLines(line).messages).toEqual([
      { id: 1, method: "authorize", params: { name: "read" } },
    ])
  })

  it("holds a partial frame back until its newline arrives", () => {
    const whole = encodeLine({ id: 7, result: { allow: true } })
    const split = Math.floor(whole.length / 2)
    const first = decodeLines(whole.slice(0, split))
    expect(first.messages).toEqual([])
    const second = decodeLines(first.rest + whole.slice(split))
    expect(second.messages).toEqual([{ id: 7, result: { allow: true } }])
    expect(second.rest).toBe("")
  })

  it("decodes several frames delivered in one chunk", () => {
    const buffer = encodeLine({ id: 1, method: "report" }) + encodeLine({ id: 2, method: "report" })
    expect(decodeLines(buffer).messages).toHaveLength(2)
  })

  it("ignores blank lines but surfaces a malformed one as null", () => {
    const { messages } = decodeLines('\n{"id":1}\nnot-json\n')
    expect(messages).toEqual([{ id: 1 }, null])
  })

  it("never mistakes a newline inside a string for a frame boundary", () => {
    const line = encodeLine({ id: 1, method: "report", params: { summary: "a\nb" } })
    const { messages } = decodeLines(line)
    expect(messages).toHaveLength(1)
    expect((messages[0] as { params: { summary: string } }).params.summary).toBe("a\nb")
  })
})

describe("constants", () => {
  it("names the two projected servers", () => {
    expect(COGNIA_TOOLS_SERVER).toBe("cognia-tools")
    expect(COGNIA_PLUGIN_TOOLS_SERVER).toBe("cognia-plugin-tools")
  })

  it("keeps the endpoint and token in env vars, never argv", () => {
    expect(TOOL_HOST_ENV).toEqual({
      socket: "COGNIA_TOOLHOST_SOCKET",
      token: "COGNIA_TOOLHOST_TOKEN",
      server: "COGNIA_TOOLHOST_SERVER",
    })
  })
})

describe("decodeLines edge cases", () => {
  it("returns nothing for an empty buffer", () => {
    expect(decodeLines("")).toEqual({ messages: [], rest: "" })
  })

  it("keeps a trailing fragment as the remainder", () => {
    expect(decodeLines('{"id":1}\n{"id"').rest).toBe('{"id"')
  })

  it("treats a whitespace-only line as nothing to decode", () => {
    expect(decodeLines("   \n\t\n").messages).toEqual([])
  })
})
