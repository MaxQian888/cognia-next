import {
  boundedDiagnostic,
  deriveTitle,
  historyFile,
  historyReasoning,
  historyText,
  historyTool,
  importedMessageId,
  importedSessionId,
  stringifyToolResult,
} from "./history"

const host = { redactText: (text: string) => text.replace(/alice@example\.com/g, "[email]") }

describe("history part constructors", () => {
  it("builds text, reasoning and file parts", () => {
    expect(historyText("hi")).toEqual({ type: "text", text: "hi" })
    expect(historyReasoning("why")).toEqual({ type: "reasoning", text: "why" })
    expect(historyFile({ mediaType: "image/*", url: "data:x" })).toEqual({
      type: "file",
      mediaType: "image/*",
      url: "data:x",
    })
    expect(historyFile({ mediaType: "image/png", url: "u", filename: "a.png" }).filename).toBe(
      "a.png"
    )
  })

  it("defaults a tool's input and leaves result and status out until recorded", () => {
    expect(historyTool({ name: "shell", toolCallId: "c1" })).toEqual({
      type: "tool",
      name: "shell",
      toolCallId: "c1",
      input: {},
    })
    expect(
      historyTool({
        name: "shell",
        toolCallId: "c1",
        input: { cmd: "ls" },
        result: { ok: false, errorText: "boom" },
        status: "",
      })
    ).toEqual({
      type: "tool",
      name: "shell",
      toolCallId: "c1",
      input: { cmd: "ls" },
      result: { ok: false, errorText: "boom" },
      status: "",
    })
  })
})

describe("stringifyToolResult", () => {
  it("keeps strings and serialises everything else", () => {
    expect(stringifyToolResult("plain")).toBe("plain")
    expect(stringifyToolResult({ a: 1 })).toBe('{"a":1}')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(stringifyToolResult(cyclic)).toBe("[object Object]")
  })
})

describe("imported ids and titles", () => {
  it("derives stable ids from the source and the runtime's own id", () => {
    expect(importedSessionId("codex", "abc")).toBe("import:codex:abc")
    expect(importedMessageId("import:codex:abc", 3)).toBe("import:codex:abc:m3")
  })

  it("collapses whitespace, truncates at 80 characters and falls back when empty", () => {
    expect(deriveTitle("  fix\n the   bug ", "fallback")).toBe("fix the bug")
    expect(deriveTitle("   ", "fallback")).toBe("fallback")
    const long = "x".repeat(100)
    expect(deriveTitle(long, "f")).toBe(`${"x".repeat(79)}…`)
  })
})

describe("boundedDiagnostic", () => {
  it("redacts every retained string through the host", () => {
    expect(boundedDiagnostic({ note: "mail alice@example.com" }, host)).toEqual({
      note: "mail [email]",
    })
  })

  it("replaces values under credential-looking keys", () => {
    expect(
      boundedDiagnostic({ api_key: "k", Authorization: "Bearer x", nested: { token: 1 } }, host)
    ).toEqual({
      api_key: "[redacted]",
      Authorization: "[redacted]",
      nested: { token: "[redacted]" },
    })
  })

  it("bounds depth, array length, key count and string length", () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
    expect(boundedDiagnostic(deep, host)).toEqual({ a: { b: { c: { d: { e: "[truncated]" } } } } })
    expect(
      (
        boundedDiagnostic(
          Array.from({ length: 50 }, (_, i) => i),
          host
        ) as unknown[]
      ).length
    ).toBe(20)
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(boundedDiagnostic(wide, host) as object)).toHaveLength(30)
    expect(boundedDiagnostic("y".repeat(1500), host)).toBe(`${"y".repeat(1000)}…`)
  })

  it("passes non-string primitives through", () => {
    expect(boundedDiagnostic(7, host)).toBe(7)
    expect(boundedDiagnostic(null, host)).toBeNull()
    expect(boundedDiagnostic(false, host)).toBe(false)
  })
})
