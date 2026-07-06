import type { UIMessage } from "ai"

import { analyzeSession, buildAssessments } from "@/lib/analysis/session-report"
import type { SessionUsageRow } from "@/lib/db/session-usage"

// Deterministic pricing: $1 / 1M input, $1 / 1M output, no cache rates.
const resolve = () => ({ promptPer1M: 1, completionPer1M: 1 })

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage
}

function assistant(id: string, parts: Record<string, unknown>[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage
}

function row(over: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    messageId: over.messageId ?? "m",
    sessionId: "s",
    at: over.at ?? 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...over,
  }
}

describe("analyzeSession", () => {
  it("returns an empty-ish report for no activity", () => {
    const r = analyzeSession({ messages: [], usageRows: [] }, { resolve })
    expect(r.turns).toBe(0)
    expect(r.totalCostUsd).toBe(0)
    expect(r.toolCallTotal).toBe(0)
    expect(r.assessments).toHaveLength(7)
    expect(r.degraded).toBe(true)
  })

  it("aggregates per-model tokens and cost via the shared analytics", () => {
    const rows = [
      row({
        messageId: "a",
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
        at: 1000,
      }),
      row({ messageId: "b", model: "gpt-4o", inputTokens: 0, outputTokens: 2_000_000, at: 2000 }),
    ]
    const r = analyzeSession({ messages: [], usageRows: rows }, { resolve })
    expect(r.models).toHaveLength(2)
    expect(r.totalInputTokens).toBe(1_000_000)
    expect(r.totalOutputTokens).toBe(2_000_000)
    expect(r.totalCostUsd).toBeCloseTo(3) // 1M input @ $1 + 2M output @ $1
    expect(r.modelSwitches).toEqual([{ from: "claude-sonnet-4-5", to: "gpt-4o" }])
  })

  it("counts tool calls, errors, denials, thinking, friction, commits, tests", () => {
    const messages = [
      user("u1", "actually undo that"),
      assistant("a1", [
        { type: "reasoning", text: "First I will plan, but I'm not sure" },
        {
          type: "tool-Bash",
          state: "output-available",
          input: { command: "git commit -m x" },
          output: "12 passed, 1 failed",
        },
        { type: "tool-Read", state: "output-error", input: { file_path: "/a.ts" } },
      ]),
      {
        id: "sys1",
        role: "system",
        parts: [{ type: "session-notice", variant: "permission-denied", toolName: "Bash" }],
      } as unknown as UIMessage,
    ]
    const r = analyzeSession({ messages, usageRows: [] }, { resolve })
    expect(r.toolCounts).toMatchObject({ Bash: 1, Read: 1 })
    expect(r.toolCallTotal).toBe(2)
    expect(r.errorCount).toBe(1)
    expect(r.denialCount).toBe(1)
    expect(r.thinkingCount).toBe(1)
    expect(r.thinkingSignals).toMatchObject({ planning: 1, uncertainty: 1 })
    expect(r.frictionTotal).toBeGreaterThanOrEqual(2)
    expect(r.commitCount).toBe(1)
    expect(r.testSnapshots).toEqual([{ messageIndex: 1, passed: 12, failed: 1 }])
  })

  it("derives idle gaps from usage-row wall-clock", () => {
    const rows = [
      row({ messageId: "a", at: 0 }),
      row({ messageId: "b", at: 120_000 }), // 120s gap
      row({ messageId: "c", at: 130_000 }), // 10s — no gap
    ]
    const r = analyzeSession({ messages: [], usageRows: rows }, { resolve, idleThresholdSec: 60 })
    expect(r.idleGaps).toEqual([{ fromAt: 0, toAt: 120_000, seconds: 120 }])
    expect(r.durationSeconds).toBe(130)
  })

  it("flattens to a linear conversation chain (degraded)", () => {
    const messages = [user("u1", "hi"), assistant("a1", [{ type: "text", text: "ok" }])]
    const r = analyzeSession({ messages, usageRows: [] }, { resolve })
    expect(r.conversationChain).toEqual(["u1", "a1"])
    expect(r.degraded).toBe(true)
  })
})

describe("buildAssessments", () => {
  const base = {
    cacheRead: 0,
    cacheCreation: 0,
    toolCallTotal: 0,
    errorCount: 0,
    bashPrefixes: new Map<string, number>(),
    fileEdits: new Map<string, number>(),
    toolCallSignatures: new Map<string, number>(),
    totalCostUsd: 0,
    commitCount: 0,
    assistantTurnsBeforeFirstWorkTool: 0,
    turns: 0,
    maxContextFraction: 0,
  }

  function find(id: string, inputs = base) {
    return buildAssessments(inputs).find((a) => a.id === id)!
  }

  it("rates cache efficiency by read/creation ratio", () => {
    expect(find("cacheEfficiency", { ...base, cacheCreation: 100, cacheRead: 10 }).level).toBe(
      "warning"
    )
    expect(find("cacheEfficiency", { ...base, cacheCreation: 100, cacheRead: 300 }).level).toBe(
      "healthy"
    )
    expect(find("cacheEfficiency").level).toBe("info") // no cache
  })

  it("escalates tool health with error rate", () => {
    expect(find("toolHealth", { ...base, toolCallTotal: 10, errorCount: 0 }).level).toBe("healthy")
    expect(find("toolHealth", { ...base, toolCallTotal: 10, errorCount: 2 }).level).toBe("warning")
    expect(find("toolHealth", { ...base, toolCallTotal: 10, errorCount: 4 }).level).toBe("critical")
  })

  it("detects thrashing at the documented thresholds", () => {
    // count 16 → score 16-4 = 12 (> 10) → warning.
    const heavy = new Map([["npm run", 16]])
    expect(find("thrashing", { ...base, bashPrefixes: heavy }).level).toBe("warning")
    expect(find("thrashing", { ...base, bashPrefixes: new Map([["npm run", 4]]) }).level).toBe(
      "healthy"
    )
    // file edited 6× → score 6-2 = 4 (> 3) → info.
    const edits = new Map([["/a.ts", 6]])
    expect(find("thrashing", { ...base, fileEdits: edits }).level).toBe("info")
  })

  it("flags redundant duplicate tool calls", () => {
    const sigs = new Map([["Read:{}", 5]])
    expect(find("redundancy", { ...base, toolCallTotal: 5, toolCallSignatures: sigs }).level).toBe(
      "warning"
    )
  })

  it("rates cost per commit", () => {
    expect(find("costPerCommit", { ...base, commitCount: 0 }).level).toBe("info")
    expect(find("costPerCommit", { ...base, commitCount: 1, totalCostUsd: 5 }).level).toBe(
      "warning"
    )
    expect(find("costPerCommit", { ...base, commitCount: 4, totalCostUsd: 1 }).level).toBe(
      "healthy"
    )
  })

  it("rates startup overhead by pre-work turns", () => {
    expect(find("overhead", { ...base, assistantTurnsBeforeFirstWorkTool: 0 }).level).toBe(
      "healthy"
    )
    expect(find("overhead", { ...base, assistantTurnsBeforeFirstWorkTool: 2 }).level).toBe("info")
    expect(find("overhead", { ...base, assistantTurnsBeforeFirstWorkTool: 5 }).level).toBe(
      "warning"
    )
  })

  it("rates context pressure against the auto-compact threshold", () => {
    expect(find("context", { ...base, maxContextFraction: 0.2 }).level).toBe("healthy")
    expect(find("context", { ...base, maxContextFraction: 0.7 }).level).toBe("warning")
    expect(find("context", { ...base, maxContextFraction: 0.9 }).level).toBe("critical")
    expect(find("context", { ...base, maxContextFraction: 0.9 }).params).toMatchObject({ pct: 90 })
  })

  it("uses a stable reasoningKey of <id>.<level>", () => {
    expect(find("context", { ...base, maxContextFraction: 0.9 }).reasoningKey).toBe(
      "context.critical"
    )
  })
})
