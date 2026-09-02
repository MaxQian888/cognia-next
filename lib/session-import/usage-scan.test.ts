// The generic usage-scan driver. What these tests pin is mostly about failure:
// a corrupt transcript must not sink a scan, a bound must produce a resumable
// cursor, and no path may ever emit a row that looks like local spend.

import {
  DEFAULT_USAGE_SCAN_QUERY,
  externalUsageMessageId,
  externalUsageSessionId,
  fingerprintSummaries,
  scanSourceUsage,
  stampExternalRow,
} from "./usage-scan"
import type {
  AgentSessionSourceAdapter,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "./types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

const input: SessionScanInput = {
  fs: {
    exists: async () => true,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  },
  home: "/home/u",
}

function summary(id: string, at: number, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    ref: { sourceId: "fake", originalSessionId: id, locator: `/x/${id}.jsonl` },
    title: "t",
    sourceId: "fake",
    messageCount: 2,
    updatedAt: at,
    ...over,
  }
}

function conversation(model: string, turns: Array<{ id: string; cost?: number }>) {
  return {
    session: { id: "s", model } as never,
    messages: turns.map((t) => ({
      id: t.id,
      role: "assistant",
      createdAt: 1000,
      metadata: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          ...(t.cost !== undefined ? { totalCostUsd: t.cost } : {}),
        },
      },
    })) as never,
  }
}

function fakeAdapter(over: Partial<AgentSessionSourceAdapter> = {}): AgentSessionSourceAdapter {
  return {
    id: "fake",
    displayName: "Fake",
    labelKey: "fake",
    acceptedExtensions: [".jsonl"],
    scanRoots: () => ["/x"],
    detect: () => "no",
    listSessions: async () => [summary("a", 3000), summary("b", 2000)],
    parseSession: async (ref: SessionRef) =>
      conversation("gpt-x", [{ id: `${ref.originalSessionId}-1`, cost: 0.25 }]) as never,
    ...over,
  }
}

describe("identity helpers", () => {
  it("namespaces message ids by source so two tools cannot collide", () => {
    expect(externalUsageMessageId("codex", "s1", "m1")).not.toBe(
      externalUsageMessageId("claude-code", "s1", "m1")
    )
  })

  it("groups rows under a per-source session key", () => {
    expect(externalUsageSessionId("codex", "s1")).toBe("ext:codex:s1")
  })
})

describe("fingerprintSummaries", () => {
  it("is stable regardless of listing order", () => {
    const a = [summary("a", 1), summary("b", 2)]
    const b = [summary("b", 2), summary("a", 1)]
    expect(fingerprintSummaries(a)).toBe(fingerprintSummaries(b))
  })

  it("changes when a session grows", () => {
    const before = [summary("a", 1, { messageCount: 2 })]
    const after = [summary("a", 1, { messageCount: 3 })]
    expect(fingerprintSummaries(before)).not.toBe(fingerprintSummaries(after))
  })

  it("changes when a session appears", () => {
    expect(fingerprintSummaries([summary("a", 1)])).not.toBe(
      fingerprintSummaries([summary("a", 1), summary("b", 1)])
    )
  })
})

describe("stampExternalRow", () => {
  const raw: SessionUsageRow = {
    messageId: "m1",
    sessionId: "orig",
    at: 5,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 1,
    durationMs: 0,
  }

  it("always marks the row imported so it cannot move a Cognia budget", () => {
    const row = stampExternalRow(raw, { sourceId: "codex", sourceSessionId: "s1" })
    expect(row.imported).toBe(true)
    expect(row.surface).toBe("imported")
  })

  it("records provenance and calls the tokens derived", () => {
    const row = stampExternalRow(raw, {
      sourceId: "codex",
      sourceSessionId: "s1",
      sourceRevision: "rev7",
    })
    expect(row).toMatchObject({
      sourceId: "codex",
      sourceSessionId: "s1",
      sourceRevision: "rev7",
      usageBasis: "derived",
    })
  })

  it("omits an absent revision instead of writing undefined", () => {
    const row = stampExternalRow(raw, { sourceId: "codex", sourceSessionId: "s1" })
    expect("sourceRevision" in row).toBe(false)
  })
})

describe("scanSourceUsage", () => {
  it("derives namespaced rows for every listed session", async () => {
    const batch = await scanSourceUsage(fakeAdapter(), input)
    expect(batch.rows.map((r) => r.messageId)).toEqual(["ext:fake:a:a-1", "ext:fake:b:b-1"])
    expect(batch.cursor).toBeNull()
    expect(batch.parsed).toBe(2)
    expect(batch.truncated).toBe(false)
  })

  it("skips a transcript that fails to parse and counts it", async () => {
    const adapter = fakeAdapter({
      parseSession: async (ref: SessionRef) => {
        if (ref.originalSessionId === "a") throw new Error("corrupt")
        return conversation("gpt-x", [{ id: "b-1", cost: 1 }]) as never
      },
    })
    const batch = await scanSourceUsage(adapter, input)
    expect(batch.failed).toBe(1)
    expect(batch.parsed).toBe(1)
    expect(batch.rows).toHaveLength(1)
    expect(batch.degradedReason).toBe("read-failed")
  })

  it("reports a missing root instead of an empty, confident zero", async () => {
    const adapter = fakeAdapter({
      listSessions: async () => {
        throw new Error("ENOENT")
      },
    })
    const batch = await scanSourceUsage(adapter, input)
    expect(batch.degradedReason).toBe("root-missing")
    expect(batch.truncated).toBe(true)
    expect(batch.rows).toHaveLength(0)
  })

  it("stops on the session bound and returns a resumable cursor", async () => {
    const batch = await scanSourceUsage(fakeAdapter(), input, { maxSessions: 1 })
    expect(batch.cursor).toBe("b")
    expect(batch.truncated).toBe(true)
    expect(batch.degradedReason).toBe("budget")
  })

  it("resumes exactly where the cursor left off", async () => {
    const first = await scanSourceUsage(fakeAdapter(), input, { maxSessions: 1 })
    const second = await scanSourceUsage(fakeAdapter(), input, { maxSessions: 1 }, first.cursor)
    expect(second.rows.map((r) => r.sourceSessionId)).toEqual(["b"])
    expect(second.cursor).toBeNull()
  })

  it("restarts the source when a cursor points at a session that vanished", async () => {
    const batch = await scanSourceUsage(fakeAdapter(), input, {}, "gone")
    expect(batch.rows).toHaveLength(2)
  })

  it("stops on the row bound too", async () => {
    const batch = await scanSourceUsage(fakeAdapter(), input, { maxRows: 1 })
    expect(batch.truncated).toBe(true)
    expect(batch.cursor).toBe("b")
  })

  it("honours an abort signal before doing any work", async () => {
    const controller = new AbortController()
    controller.abort()
    const batch = await scanSourceUsage(fakeAdapter(), input, { signal: controller.signal })
    expect(batch.degradedReason).toBe("aborted")
    expect(batch.rows).toHaveLength(0)
  })

  it("skips sessions older than the incremental watermark", async () => {
    const batch = await scanSourceUsage(fakeAdapter(), input, { sinceMs: 2500 })
    expect(batch.rows.map((r) => r.sourceSessionId)).toEqual(["a"])
    // Everything newer was read, so the source is complete despite the skip.
    expect(batch.cursor).toBeNull()
  })

  it("returns nothing for a picker-only source rather than pretending to scan", async () => {
    const batch = await scanSourceUsage(fakeAdapter({ pickerOnly: true }), input)
    expect(batch).toEqual({ rows: [], cursor: null, parsed: 0, failed: 0, truncated: false })
  })

  it("delegates to an adapter that implements scanUsage", async () => {
    const scanUsage = jest.fn(async () => ({
      rows: [],
      cursor: null,
      parsed: 9,
      failed: 0,
      truncated: false,
    }))
    const batch = await scanSourceUsage(fakeAdapter({ scanUsage }), input)
    expect(scanUsage).toHaveBeenCalled()
    expect(batch.parsed).toBe(9)
  })

  it("exposes conservative default bounds", () => {
    expect(DEFAULT_USAGE_SCAN_QUERY.maxRows).toBeLessThanOrEqual(250)
    expect(DEFAULT_USAGE_SCAN_QUERY.maxSessions).toBeLessThanOrEqual(100)
  })
})
