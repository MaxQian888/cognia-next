import type { AttentionItem } from "@/lib/attention/types"
import type { FleetSession } from "@/lib/fleet/types"
import { detailFromAttention, detailFromSession } from "./detail"

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
    cwd: "/Users/me/proj",
    projectName: "proj",
    lastPrompt: "email me at person@example.com",
    activity: { toolName: "Bash", detail: "pnpm test" },
    permissionMode: "plan",
    model: "claude-opus-5",
    terminal: { app: "iterm", label: "iTerm", sessionRef: "w0t1" },
    transcriptPath: null,
    agentPid: 42,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      interrupt: false,
    },
    startedAt: 1000,
    lastEventAt: 2000,
    toolUseCount: 3,
    turnCount: 2,
    ...overrides,
  }
}

describe("detailFromSession", () => {
  it("carries the facts the collapsed row deliberately omits", () => {
    const detail = detailFromSession(session({ gitBranch: "dev", startSource: "resume" }))
    expect(detail.cwd).toBe("/Users/me/proj")
    expect(detail.gitBranch).toBe("dev")
    expect(detail.terminal).toEqual({ sessionRef: "w0t1" })
    expect(detail.model).toBe("claude-opus-5")
    expect(detail.permissionMode).toBe("plan")
    expect(detail.toolUseCount).toBe(3)
    expect(detail.activityLabel).toBe("Bash: pnpm test")
  })

  it("redacts personal data out of the prompt", () => {
    const detail = detailFromSession(session())
    expect(detail.prompt).not.toContain("person@example.com")
  })

  it("caps a long plan rather than shipping the whole thing", () => {
    const detail = detailFromSession(session({ pendingPlan: "x".repeat(2000) }))
    expect(detail.plan!.length).toBeLessThanOrEqual(400)
  })

  it("omits an absent field instead of emitting an empty string", () => {
    const detail = detailFromSession(session({ lastPrompt: null, activity: null, cwd: null }))
    expect(detail).not.toHaveProperty("prompt")
    expect(detail).not.toHaveProperty("activityLabel")
    expect(detail.cwd).toBeNull()
  })
})

describe("detailFromAttention", () => {
  it("reports zero counters for an ask with no runtime behind it", () => {
    const detail = detailFromAttention({
      id: "team:a:b",
      source: "team",
      kind: "hitl-gate",
      title: "Approve deploy",
      detail: "deploy to prod",
      openedAt: 900,
      stale: false,
    } as AttentionItem)
    expect(detail.toolUseCount).toBe(0)
    expect(detail.turnCount).toBe(0)
    expect(detail.startedAt).toBe(900)
    expect(detail.prompt).toBe("deploy to prod")
  })
})
