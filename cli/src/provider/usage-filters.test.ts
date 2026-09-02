// CLI usage filters. The scope check is the one that matters: `cognia` must
// exclude every external row, because that total is what a person compares
// against their own invoice.

import {
  applyFilters,
  formatSourceDiagnostic,
  isExternalSessionId,
  parseScope,
  rowMatches,
  sourceOfSessionId,
  USAGE_CLI_SCOPES,
  type FilterableRow,
  type SourceDiagnostic,
} from "./usage-filters"

function row(over: Partial<FilterableRow> = {}): FilterableRow {
  return {
    model: "claude-opus-4",
    providerId: "anthropic",
    attribution: "exact",
    turns: 1,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 1,
    costKnown: true,
    sessionId: "chat-1",
    ...over,
  }
}

describe("sourceOfSessionId", () => {
  it("reads the source out of the prefix the external index writes", () => {
    expect(sourceOfSessionId("ext:codex:abc")).toBe("codex")
  })

  it("still understands the older importer prefix", () => {
    expect(sourceOfSessionId("import:claude-code:abc")).toBe("claude-code")
  })

  it("is null for a local session", () => {
    expect(sourceOfSessionId("chat-1")).toBeNull()
    expect(sourceOfSessionId("")).toBeNull()
  })

  it("handles a namespaced source id with no trailing segment", () => {
    expect(sourceOfSessionId("ext:codex")).toBe("codex")
    expect(sourceOfSessionId("ext:")).toBeNull()
  })
})

describe("isExternalSessionId", () => {
  it("separates the two worlds", () => {
    expect(isExternalSessionId("ext:codex:a")).toBe(true)
    expect(isExternalSessionId("chat-1")).toBe(false)
  })
})

describe("parseScope", () => {
  it("defaults to this app, which is the scope a budget is compared against", () => {
    expect(parseScope(undefined)).toBe("cognia")
  })

  it("accepts the declared vocabulary and rejects everything else", () => {
    expect(parseScope("all-tools")).toBe("all-tools")
    expect(parseScope("everything")).toBeNull()
  })

  it("declares two scopes and no more", () => {
    expect(USAGE_CLI_SCOPES).toEqual(["cognia", "all-tools"])
  })
})

describe("rowMatches", () => {
  it("keeps a local row out of nobody's way", () => {
    expect(rowMatches(row(), { scope: "cognia" })).toBe(true)
  })

  it("excludes an external row from the cognia scope", () => {
    expect(rowMatches(row({ sessionId: "ext:codex:a" }), { scope: "cognia" })).toBe(false)
  })

  it("includes it in all-tools", () => {
    expect(rowMatches(row({ sessionId: "ext:codex:a" }), { scope: "all-tools" })).toBe(true)
  })

  it("treats a row with no session id as local", () => {
    // Ledger rows aggregate away the session, and the ledger read already
    // excludes imported spend, so "no session" means "this install".
    expect(rowMatches(row({ sessionId: undefined }), { scope: "cognia" })).toBe(true)
  })

  it("filters to one external source", () => {
    const filters = { scope: "all-tools" as const, sourceId: "codex" }
    expect(rowMatches(row({ sessionId: "ext:codex:a" }), filters)).toBe(true)
    expect(rowMatches(row({ sessionId: "ext:cursor:a" }), filters)).toBe(false)
    expect(rowMatches(row({ sessionId: undefined }), filters)).toBe(false)
  })

  it("matches a model substring, case-insensitively", () => {
    expect(rowMatches(row(), { scope: "cognia", model: "OPUS" })).toBe(true)
    expect(rowMatches(row(), { scope: "cognia", model: "haiku" })).toBe(false)
  })

  it("filters by provider", () => {
    expect(rowMatches(row(), { scope: "cognia", providerId: "anthropic" })).toBe(true)
    expect(rowMatches(row(), { scope: "cognia", providerId: "openai" })).toBe(false)
  })
})

describe("applyFilters", () => {
  it("keeps only the surviving rows, in order", () => {
    const rows = [
      row({ model: "opus" }),
      row({ model: "haiku" }),
      row({ model: "opus", sessionId: "ext:codex:a" }),
    ]
    expect(applyFilters(rows, { scope: "cognia", model: "opus" })).toHaveLength(1)
  })
})

describe("formatSourceDiagnostic", () => {
  const base: SourceDiagnostic = {
    sourceId: "codex",
    displayName: "Codex",
    status: "fresh",
    supportsScan: true,
    rowCount: 42,
    failedCount: 0,
    lastScanAt: 1,
  }

  it("reports a healthy source with its row count", () => {
    expect(formatSourceDiagnostic(base)).toContain("42 rows")
  })

  it("says a source was never scanned rather than reporting zero spend", () => {
    expect(formatSourceDiagnostic({ ...base, status: "unknown" })).toContain("not scanned")
  })

  it("says a source was unreadable, which is not the same as empty", () => {
    // Collapsing these two is the confusion `usageSourceStates` exists to stop.
    expect(formatSourceDiagnostic({ ...base, status: "unavailable" })).toContain("unreadable")
  })

  it("names a picker-only source's actual limitation", () => {
    expect(formatSourceDiagnostic({ ...base, supportsScan: false })).toContain("picker only")
  })

  it("discloses a partial scan and its unreadable files", () => {
    const line = formatSourceDiagnostic({ ...base, status: "partial", failedCount: 3 })
    expect(line).toContain("3 unreadable")
    expect(line).toContain("(partial)")
  })
})
