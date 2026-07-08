import { activityLine, attentionCount, formatElapsed, sortForIsland, truncateLine } from "./format"
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
    },
    startedAt: 0,
    lastEventAt: 0,
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
