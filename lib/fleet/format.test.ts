import {
  activityLine,
  attentionCount,
  attentionSeverity,
  fleetStatusSummary,
  formatCwdMiddle,
  formatElapsed,
  formatModelLabel,
  normalizeIslandGeometry,
  sortForIsland,
  truncateLine,
} from "./format"
import type { FleetSession } from "./types"

function session(overrides: Partial<FleetSession>): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s",
    status: "idle",
    cwd: null,
    projectName: null,
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      interrupt: false,
    },
    startedAt: 0,
    lastEventAt: 0,
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

describe("formatElapsed", () => {
  it("renders seconds, minutes and hours compactly", () => {
    expect(formatElapsed(0, 42_000)).toBe("42s")
    expect(formatElapsed(0, 2 * 60_000 + 14_000)).toBe("2m14s")
    expect(formatElapsed(0, 60 * 60_000 + 37 * 60_000)).toBe("1h37m")
    expect(formatElapsed(0, 2 * 3600_000 + 5 * 60_000)).toBe("2h05m")
  })

  it("clamps a future start to zero", () => {
    expect(formatElapsed(10_000, 0)).toBe("0s")
  })
})

describe("truncateLine", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(truncateLine("a  b\n\tc", 10)).toBe("a b c")
    expect(truncateLine("x".repeat(30), 10)).toBe("xxxxxxxxx…")
    expect(truncateLine("x".repeat(30), 10)).toHaveLength(10)
  })
})

describe("activityLine", () => {
  it("joins tool name and detail, tool-only when no detail", () => {
    expect(activityLine(session({ activity: { toolName: "Bash", detail: "pnpm test" } }))).toBe(
      "Bash(pnpm test)"
    )
    expect(activityLine(session({ activity: { toolName: "Read", detail: null } }))).toBe("Read")
    expect(activityLine(session({}))).toBeNull()
  })
})

describe("sortForIsland", () => {
  it("ranks attention states above working above idle, recency within rank", () => {
    const rows = sortForIsland([
      session({ sessionId: "idle-new", status: "idle", lastEventAt: 100 }),
      session({ sessionId: "work", status: "working", lastEventAt: 1 }),
      session({ sessionId: "perm", status: "waiting-permission", lastEventAt: 1 }),
      session({ sessionId: "plan", status: "plan-pending", lastEventAt: 1 }),
      session({ sessionId: "input", status: "waiting-input", lastEventAt: 1 }),
      session({ sessionId: "idle-old", status: "idle", lastEventAt: 50 }),
    ])
    expect(rows.map((r) => r.sessionId)).toEqual([
      "perm",
      "plan",
      "input",
      "work",
      "idle-new",
      "idle-old",
    ])
  })
})

describe("attentionCount", () => {
  it("counts permission, plan and input states only", () => {
    expect(
      attentionCount([
        session({ status: "waiting-permission" }),
        session({ status: "plan-pending" }),
        session({ status: "waiting-input" }),
        session({ status: "working" }),
        session({ status: "idle" }),
        session({ status: "ended" }),
      ])
    ).toBe(3)
  })
})

describe("formatModelLabel", () => {
  it("collapses known Claude families to their short brand name", () => {
    expect(formatModelLabel("claude-opus-4-8")).toBe("Opus")
    expect(formatModelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet")
    expect(formatModelLabel("anthropic/claude-haiku-4-5")).toBe("Haiku")
    expect(formatModelLabel("opusplan")).toBe("Opus")
  })

  it("recognizes other providers", () => {
    expect(formatModelLabel("gemini-2.5-pro")).toBe("Gemini")
    expect(formatModelLabel("grok-4")).toBe("Grok")
  })

  it("cleans generic ids: provider prefix, release date, gpt casing", () => {
    expect(formatModelLabel("openai/gpt-4o")).toBe("GPT-4o")
    expect(formatModelLabel("gpt-5-codex")).toBe("GPT-5-codex")
    expect(formatModelLabel("o1-preview-2024-09-12")).toBe("o1-preview")
    expect(formatModelLabel("deepseek-chat")).toBe("deepseek-chat")
  })

  it("caps overly long labels and returns null for empty input", () => {
    expect(formatModelLabel("x".repeat(40))).toHaveLength(22)
    expect(formatModelLabel("x".repeat(40))?.endsWith("…")).toBe(true)
    expect(formatModelLabel(null)).toBeNull()
    expect(formatModelLabel("  ")).toBeNull()
    expect(formatModelLabel(undefined)).toBeNull()
  })
})

describe("fleetStatusSummary", () => {
  it("buckets sessions by status with a total", () => {
    expect(
      fleetStatusSummary([
        session({ status: "waiting-permission" }),
        session({ status: "plan-pending" }),
        session({ status: "waiting-input" }),
        session({ status: "working" }),
        session({ status: "working" }),
        session({ status: "idle" }),
        session({ status: "detached" }),
        session({ status: "ended" }),
      ])
    ).toEqual({ attention: 3, working: 2, idle: 1, detached: 1, ended: 1, total: 8 })
  })

  it("is all-zero for an empty fleet", () => {
    expect(fleetStatusSummary([])).toEqual({
      attention: 0,
      working: 0,
      idle: 0,
      detached: 0,
      ended: 0,
      total: 0,
    })
  })
})

describe("attentionSeverity", () => {
  it("is none when nothing needs the user", () => {
    expect(attentionSeverity([session({ status: "working" }), session({ status: "idle" })])).toBe(
      "none"
    )
  })

  it("is input for a plan or input wait", () => {
    expect(
      attentionSeverity([session({ status: "working" }), session({ status: "waiting-input" })])
    ).toBe("input")
    expect(attentionSeverity([session({ status: "plan-pending" })])).toBe("input")
  })

  it("prioritizes a permission over an input wait regardless of order", () => {
    expect(
      attentionSeverity([
        session({ status: "waiting-input" }),
        session({ status: "waiting-permission" }),
      ])
    ).toBe("permission")
  })

  it("treats a parked pendingPermission as permission even without the status", () => {
    expect(
      attentionSeverity([
        session({
          status: "working",
          pendingPermission: { requestId: "r", toolName: null, detail: null, requestedAt: 0 },
        }),
      ])
    ).toBe("permission")
  })
})

describe("formatCwdMiddle", () => {
  it("returns a path shorter than the cap unchanged", () => {
    expect(formatCwdMiddle("/a/b/c", 44)).toBe("/a/b/c")
  })

  it("middle-ellipsizes a long path, keeping both ends within the cap", () => {
    const p = "/Users/someone/very/deeply/nested/path/to/the/project/x"
    const out = formatCwdMiddle(p, 20)
    expect(out).toContain("…")
    expect(out.startsWith("/Users")).toBe(true)
    expect(out.endsWith("x")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(20)
  })
})

describe("normalizeIslandGeometry", () => {
  it("passes a well-formed payload through", () => {
    expect(normalizeIslandGeometry({ topInset: 37, fullscreen: true })).toEqual({
      topInset: 37,
      fullscreen: true,
    })
  })

  it("treats a missing or malformed payload as no-notch, not-full-screen", () => {
    // Both defaults are the conservative direction: a wrong inset hides the card
    // under the camera housing, and a wrong full-screen verdict makes the whole
    // island vanish.
    for (const raw of [undefined, null, {}, 37, "37", [], { topInset: null }]) {
      expect(normalizeIslandGeometry(raw)).toEqual({ topInset: 0, fullscreen: false })
    }
  })

  it("rejects non-finite and non-positive insets", () => {
    expect(normalizeIslandGeometry({ topInset: NaN }).topInset).toBe(0)
    expect(normalizeIslandGeometry({ topInset: Infinity }).topInset).toBe(0)
    expect(normalizeIslandGeometry({ topInset: -5 }).topInset).toBe(0)
    expect(normalizeIslandGeometry({ topInset: 0 }).topInset).toBe(0)
  })

  it("requires an explicit boolean true for full-screen", () => {
    expect(normalizeIslandGeometry({ fullscreen: "true" }).fullscreen).toBe(false)
    expect(normalizeIslandGeometry({ fullscreen: 1 }).fullscreen).toBe(false)
    expect(normalizeIslandGeometry({ fullscreen: false }).fullscreen).toBe(false)
    expect(normalizeIslandGeometry({ fullscreen: true }).fullscreen).toBe(true)
  })
})
