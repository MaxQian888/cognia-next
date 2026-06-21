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

  it("lifts an embedded JSON payload out of a prose/log prefix into a tree", () => {
    // Regression: a CLI error like lark-cli's `Exit code 1\nerror: …\n{ … }`
    // used to have its whole JSON body swallowed line-by-line by the log
    // parser (one gutter-barred `log` node per line, indentation lost).
    const text =
      "Exit code 1\nerror: jq error: expected an object but got: boolean (false)\n" +
      '{"ok": false, "error": {"type": "jq_error"}, "_notice": {"update": {"latest": "1.0.39"}}}'
    const result = defaultPreset.parse(text)

    expect(result.parsed).toBe(true)
    // The JSON body is a single tree node carrying the parsed value...
    const json = result.nodes.find((n) => n.kind === "json")
    expect(json).toBeDefined()
    expect((json!.value as { ok: boolean }).ok).toBe(false)
    // ...the `error:` line is still a styled log node...
    expect(result.nodes.some((n) => n.kind === "log" && n.level === "error")).toBe(true)
    // ...and no JSON line leaked out as its own log node.
    expect(result.nodes.filter((n) => n.kind === "log")).toHaveLength(1)
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

  it("categorises a network errno error", () => {
    const result = defaultPreset.parse("Error: connect ECONNREFUSED 127.0.0.1:3000")
    expect(result.parsed).toBe(true)
    expect(
      result.nodes.some((n) => n.kind === "category" && n.category === "connectionRefused")
    ).toBe(true)
  })

  it("maps a numbered HTTP status to a statusCode node", () => {
    const result = defaultPreset.parse("Request failed with status 429 Too Many Requests")
    expect(result.parsed).toBe(true)
    expect(result.nodes.some((n) => n.kind === "statusCode" && n.status === 429)).toBe(true)
  })

  it("categorises a sidecar/session runtime error", () => {
    const result = defaultPreset.parse("session e1a2 did not end within 30000ms")
    expect(result.parsed).toBe(true)
    expect(result.nodes.some((n) => n.kind === "category" && n.category === "sessionTimeout")).toBe(
      true
    )
  })

  it("renders both a clickable stack and a network category for a Node error", () => {
    const result = defaultPreset.parse(
      "Error: connect ECONNREFUSED 127.0.0.1:3000\n    at handler (/app/net.js:1247:16)"
    )
    expect(result.parsed).toBe(true)
    expect(result.nodes.some((n) => n.kind === "stack")).toBe(true)
    expect(
      result.nodes.some((n) => n.kind === "category" && n.category === "connectionRefused")
    ).toBe(true)
  })
})
