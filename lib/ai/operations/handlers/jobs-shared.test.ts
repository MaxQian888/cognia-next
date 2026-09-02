/** @jest-environment node */
import { isoMs, jobStatusOf, openAiCursor, query } from "./jobs-shared"

describe("job helpers", () => {
  it("maps vendor words to the contract statuses, unknown words to running", () => {
    const table = { completed: "succeeded" as const, FAILED: "failed" as const }
    expect(jobStatusOf("completed", table)).toBe("succeeded")
    expect(jobStatusOf("FAILED", table)).toBe("failed")
    expect(jobStatusOf("finalizing", table)).toBe("running")
    expect(jobStatusOf(undefined, table)).toBe("queued")
  })

  it("builds cursors and query strings", () => {
    expect(query({ limit: 5, after: undefined, purpose: "a b" })).toBe("?limit=5&purpose=a%20b")
    expect(query({})).toBe("")
    expect(openAiCursor({ has_more: true, data: [{ id: "x" }] })).toBe("x")
    expect(openAiCursor({ has_more: true, last_id: "y", data: [{ id: "x" }] })).toBe("y")
    expect(openAiCursor({ has_more: false, data: [{ id: "x" }] })).toBeNull()
    expect(isoMs("2026-09-01T00:00:00Z")).toBe(Date.parse("2026-09-01T00:00:00Z"))
    expect(isoMs("soon")).toBeUndefined()
  })
})
