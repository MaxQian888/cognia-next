/**
 * @jest-environment node
 */

import { redactStructuredLogEntry } from "./redaction"
import { DEFAULT_UNIFIED_CONFIG } from "./types"
import type { LoggerRedactionConfig, StructuredLogEntry } from "./types"

const REDACTION = DEFAULT_UNIFIED_CONFIG.redaction
const REPLACEMENT = REDACTION.replacement

function makeEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "log-1",
    timestamp: "2026-04-29T00:00:00.000Z",
    level: "info",
    message: "hello",
    module: "test",
    runtime: "browser",
    origin: "frontend",
    ...overrides,
  }
}

describe("redactStructuredLogEntry", () => {
  it("returns the entry unchanged when redaction is disabled", () => {
    const entry = makeEntry({ data: { password: "secret123" } })
    const out = redactStructuredLogEntry(entry, { ...REDACTION, enabled: false })
    expect(out).toBe(entry)
    expect(out.data).toEqual({ password: "secret123" })
  })

  it("redacts values whose key matches a configured key", () => {
    const out = redactStructuredLogEntry(
      makeEntry({ data: { password: "secret123", username: "alice" } }),
      REDACTION
    )
    expect(out.data).toEqual({ password: REPLACEMENT, username: "alice" })
  })

  it("redacts keys regardless of separators or casing", () => {
    const out = redactStructuredLogEntry(
      makeEntry({
        data: {
          API_KEY: "ak_live_xyz",
          "Access-Token": "abc",
          PRIVATE_KEY: "rsa…",
          username: "alice",
        },
      }),
      REDACTION
    )
    expect(out.data).toEqual({
      API_KEY: REPLACEMENT,
      "Access-Token": REPLACEMENT,
      PRIVATE_KEY: REPLACEMENT,
      username: "alice",
    })
  })

  it("matches keys via substring inclusion", () => {
    const out = redactStructuredLogEntry(
      makeEntry({ data: { user_password_hash: "x" } }),
      REDACTION
    )
    expect(out.data).toEqual({ user_password_hash: REPLACEMENT })
  })

  it("redacts text matching configured regex patterns inside message + stack", () => {
    const config: LoggerRedactionConfig = {
      ...REDACTION,
      redactPatterns: ["sk-[A-Za-z0-9]{6,}"],
    }
    const out = redactStructuredLogEntry(
      makeEntry({
        message: "calling api with sk-abcdef123456",
        stack: "Error: see token sk-abcdef123456",
      }),
      config
    )
    expect(out.message).toBe(`calling api with ${REPLACEMENT}`)
    expect(out.stack).toBe(`Error: see token ${REPLACEMENT}`)
  })

  it("reuses compiled regex instances when the same config is redacted repeatedly", () => {
    const config: LoggerRedactionConfig = {
      ...REDACTION,
      redactPatterns: ["sk-[A-Za-z0-9]{6,}"],
    }
    const replaceSpy = jest.spyOn(String.prototype, "replace")

    try {
      redactStructuredLogEntry(makeEntry({ message: "calling api with sk-abcdef123456" }), config)
      redactStructuredLogEntry(makeEntry({ message: "calling api with sk-fedcba654321" }), config)

      const patterns = replaceSpy.mock.calls
        .map(([pattern]) => pattern)
        .filter((pattern): pattern is RegExp => pattern instanceof RegExp)
      expect(patterns).toHaveLength(2)
      expect(patterns[1]).toBe(patterns[0])
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("ignores invalid regex patterns instead of throwing", () => {
    const config: LoggerRedactionConfig = {
      ...REDACTION,
      redactPatterns: ["[invalid"],
    }
    expect(() => redactStructuredLogEntry(makeEntry({ message: "ok" }), config)).not.toThrow()
  })

  it("recursively redacts arrays and nested objects", () => {
    const entry = makeEntry({
      data: {
        users: [
          { name: "alice", password: "p1" },
          { name: "bob", password: "p2" },
        ],
        env: { SECRET: "shh", visible: 1 },
      },
    })
    const out = redactStructuredLogEntry(entry, REDACTION)
    expect(out.data).toEqual({
      users: [
        { name: "alice", password: REPLACEMENT },
        { name: "bob", password: REPLACEMENT },
      ],
      env: { SECRET: REPLACEMENT, visible: 1 },
    })
  })

  it("stops descending past maxDepth without throwing", () => {
    const config: LoggerRedactionConfig = { ...REDACTION, maxDepth: 1 }
    const entry = makeEntry({
      data: {
        level1: { password: "should-not-redact-here", n: 1 },
      },
    })
    const out = redactStructuredLogEntry(entry, config) as StructuredLogEntry
    // depth-1 stops descent into level1; the inner object is preserved as-is.
    expect(out.data).toEqual({
      level1: { password: "should-not-redact-here", n: 1 },
    })
  })

  it("breaks circular references with the replacement marker", () => {
    type Cyclic = { name: string; self?: Cyclic }
    const cyclic: Cyclic = { name: "alice" }
    cyclic.self = cyclic
    const out = redactStructuredLogEntry(
      makeEntry({ data: { cyclic: cyclic as unknown as Record<string, unknown> } }),
      REDACTION
    )
    const data = out.data as { cyclic: { name: string; self: unknown } }
    expect(data.cyclic.name).toBe("alice")
    expect(data.cyclic.self).toBe(REPLACEMENT)
  })

  it("preserves primitives, dates, and missing data", () => {
    const date = new Date("2024-01-01T00:00:00Z")
    const out = redactStructuredLogEntry(
      makeEntry({
        data: { n: 42, b: true, big: BigInt(7), when: date, gone: null, miss: undefined },
      }),
      REDACTION
    )
    expect(out.data).toEqual({
      n: 42,
      b: true,
      big: BigInt(7),
      when: date.toISOString(),
      gone: null,
      miss: undefined,
    })

    const noData = redactStructuredLogEntry(makeEntry({ data: undefined }), REDACTION)
    expect(noData.data).toBeUndefined()
  })

  it("does not mutate the input entry", () => {
    const entry = makeEntry({ data: { password: "secret" } })
    const snapshot = JSON.stringify(entry)
    redactStructuredLogEntry(entry, REDACTION)
    expect(JSON.stringify(entry)).toBe(snapshot)
  })
})
