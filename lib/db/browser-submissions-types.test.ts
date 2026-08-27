import type { BrowserSubmissionRow } from "./browser-submissions-types"

function row(overrides: Partial<BrowserSubmissionRow> = {}): BrowserSubmissionRow {
  return {
    submissionId: "sub-1",
    deviceId: "browser-a",
    sessionId: "session-1",
    title: "A guide",
    sourceHost: "example.com",
    captureMode: "selection",
    contentBytes: 120,
    truncated: false,
    status: "queued",
    submittedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("BrowserSubmissionRow", () => {
  it("carries every field the schema declares an index on", async () => {
    // Read from the schema rather than hand-copied, so an index added there
    // without a field here fails at the moment it is added — Dexie itself
    // silently ignores an index whose keyPath is never present, and the query
    // that needed it then returns nothing rather than erroring.
    const { readFile } = await import("node:fs/promises")
    const schema = await readFile("lib/db/schema.ts", "utf8")
    const declaration = /browserSubmissions:\s*"([^"]+)"/.exec(schema)
    expect(declaration).not.toBeNull()
    const indexed = (declaration?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^&/, ""))
      // Compound indexes name their parts; check each part instead.
      .flatMap((entry) =>
        entry.startsWith("[")
          ? entry
              .slice(1, -1)
              .split("+")
              .map((p) => p.trim())
          : [entry]
      )
    const sample = row() as unknown as Record<string, unknown>
    for (const field of indexed) {
      expect(sample[field]).toBeDefined()
    }
    expect(indexed).toContain("deviceId")
  })

  it("holds no page text, no instruction and no full URL", () => {
    // The privacy contract, expressed as a shape rather than a promise: the
    // transcript owns the content, under controls the user can reach. If a
    // field for any of it ever appears, this fails.
    const fields = Object.keys(row())
    for (const forbidden of ["text", "instruction", "prompt", "url", "selection", "readableText"]) {
      expect(fields).not.toContain(forbidden)
    }
    // What stands in for the page: a hostname and a byte count.
    expect(fields).toContain("sourceHost")
    expect(fields).toContain("contentBytes")
  })

  it("records a failure code only alongside a failure", () => {
    // `errorCode` is optional because every non-failed row would otherwise
    // carry an empty string that reads, in a list, like a redacted error.
    expect(row().errorCode).toBeUndefined()
    expect(row({ status: "failed", errorCode: "runtime_unavailable" }).errorCode).toBe(
      "runtime_unavailable"
    )
  })
})
