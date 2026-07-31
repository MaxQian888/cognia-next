/**
 * @jest-environment node
 */

import { normalizeErrorText } from "./normalize"

describe("normalizeErrorText", () => {
  it("passes strings through", () => {
    expect(normalizeErrorText("boom")).toBe("boom")
  })

  it("uses the fallback for empty / nullish input", () => {
    expect(normalizeErrorText("", "fallback")).toBe("fallback")
    expect(normalizeErrorText(null, "fallback")).toBe("fallback")
    expect(normalizeErrorText(undefined, "fallback")).toBe("fallback")
    expect(normalizeErrorText(null)).toBe("")
  })

  it("prefers an Error's stack so frames stay clickable", () => {
    const err = new Error("kaboom")
    err.stack = "Error: kaboom\n    at fn (/app/x.ts:1:2)"
    expect(normalizeErrorText(err)).toBe(err.stack)
  })

  it("falls back to an Error's message when it has no stack", () => {
    const err = new Error("kaboom")
    err.stack = ""
    expect(normalizeErrorText(err)).toBe("kaboom")
  })

  it("uses a stack string on an Error-like object", () => {
    const stack = "TypeError: nope\n    at g (/app/y.ts:3:4)"
    expect(normalizeErrorText({ message: "nope", stack })).toBe(stack)
  })

  it("treats a bare { message } as plain text", () => {
    expect(normalizeErrorText({ message: "just a message" })).toBe("just a message")
  })

  it("JSON-stringifies structured objects so parsers can render them", () => {
    const envelope = { type: "error", error: { type: "rate_limit_error", message: "slow down" } }
    expect(normalizeErrorText(envelope)).toBe(JSON.stringify(envelope, null, 2))
  })

  it("JSON-stringifies a message object that carries extra keys", () => {
    const obj = { message: "failed", code: "ECONNREFUSED" }
    expect(normalizeErrorText(obj)).toBe(JSON.stringify(obj, null, 2))
  })

  it("survives circular objects via String() fallback", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(normalizeErrorText(circular)).toBe("[object Object]")
  })

  it("stringifies primitives", () => {
    expect(normalizeErrorText(42)).toBe("42")
    expect(normalizeErrorText(true)).toBe("true")
  })
})
