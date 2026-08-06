/**
 * @cognia/agent runtime tests.
 *
 * These test the public SDK facade — `createCogniaRuntime`, `CogniaSession` —
 * by injecting fake collaborators so no real sidecar, provider, or filesystem
 * is needed.
 */

import { validateAnnotation, type SessionAnnotation } from "./runtime"

// ─── Annotation validation ───────────────────────────────────────────────────

describe("validateAnnotation", () => {
  const valid: SessionAnnotation = {
    type: "ci/build-result",
    summary: "Build passed",
    data: { exitCode: 0, duration: 12.5 },
  }

  it("accepts a valid annotation", () => {
    expect(validateAnnotation(valid)).toBeNull()
  })

  it("rejects empty type", () => {
    const err = validateAnnotation({ ...valid, type: "" })
    expect(err).not.toBeNull()
    expect(err!.code).toBe("usage_error")
  })

  it("rejects type with invalid characters", () => {
    const err = validateAnnotation({ ...valid, type: "has spaces" })
    expect(err).not.toBeNull()
    expect(err!.code).toBe("usage_error")
  })

  it("rejects type exceeding 128 chars", () => {
    const err = validateAnnotation({ ...valid, type: "a".repeat(129) })
    expect(err).not.toBeNull()
  })

  it("accepts type with dots, slashes, dashes, underscores", () => {
    expect(validateAnnotation({ ...valid, type: "my-plugin/v2.0/state_check" })).toBeNull()
  })

  it("rejects empty summary", () => {
    const err = validateAnnotation({ ...valid, summary: "" })
    expect(err).not.toBeNull()
  })

  it("rejects summary exceeding 512 chars", () => {
    const err = validateAnnotation({ ...valid, summary: "x".repeat(513) })
    expect(err).not.toBeNull()
  })

  it("rejects non-serializable data", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const err = validateAnnotation({ ...valid, data: circular })
    expect(err).not.toBeNull()
    expect(err!.message).toContain("JSON-serializable")
  })

  it("rejects data exceeding 64 KiB", () => {
    const bigData = { payload: "x".repeat(65 * 1024) }
    const err = validateAnnotation({ ...valid, data: bigData })
    expect(err).not.toBeNull()
    expect(err!.message).toContain("65536")
  })

  it("allows undefined data", () => {
    expect(validateAnnotation({ type: "test/ping", summary: "ping" })).toBeNull()
  })

  it("allows null and boolean in data", () => {
    expect(validateAnnotation({ ...valid, data: null })).toBeNull()
    expect(validateAnnotation({ ...valid, data: true })).toBeNull()
  })
})
