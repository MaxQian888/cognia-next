import type { AttentionItem } from "@/lib/attention/types"
import type { FleetSession } from "@/lib/fleet/types"
import { attentionOwner, fleetSessionOwner, ownerRoute, sameOwner, taskIdentity } from "./owner"

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
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
    startedAt: 1000,
    lastEventAt: 2000,
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

describe("fleetSessionOwner", () => {
  it("routes an external CLI to its own session", () => {
    const owner = fleetSessionOwner(session({ agent: "codex", transcriptPath: "/t.jsonl" }))
    expect(owner).toEqual({
      kind: "external",
      agent: "codex",
      sessionId: "s1",
      transcriptPath: "/t.jsonl",
    })
  })

  it("routes a cognia team run to the team", () => {
    const owner = fleetSessionOwner(
      session({ agent: "cognia", agentTeamId: "team-1", agentTeamRunId: "run-1" })
    )
    expect(owner).toEqual({ kind: "team", teamId: "team-1", runId: "run-1" })
  })

  it("routes a cognia execution run to the run", () => {
    expect(fleetSessionOwner(session({ agent: "cognia", executionRunId: "r9" }))).toEqual({
      kind: "run",
      runId: "r9",
    })
  })

  it("falls back to chat for a plain cognia session", () => {
    expect(fleetSessionOwner(session({ agent: "cognia", sessionId: "chat-7" }))).toEqual({
      kind: "chat",
      sessionId: "chat-7",
    })
  })
})

describe("attentionOwner", () => {
  const base = { title: "t", openedAt: 1, stale: false } as const

  it("keys a chat approval by session and request", () => {
    const item = {
      ...base,
      id: "chat:req",
      source: "chat",
      kind: "tool-approval",
      sessionId: "sess",
      approval: { requestId: "req" },
    } as unknown as AttentionItem
    expect(attentionOwner(item)).toEqual({ kind: "chat", sessionId: "sess", requestId: "req" })
  })

  it("returns null when the discriminating id is missing", () => {
    const item = { ...base, id: "team::", source: "team", kind: "hitl-gate" } as AttentionItem
    expect(attentionOwner(item)).toBeNull()
  })

  it("reuses the fleet owner for a fleet item, so it merges with its session row", () => {
    const fleetSession = session({ agent: "opencode", sessionId: "oc" })
    const item = {
      ...base,
      id: "fleet:opencode:oc",
      source: "fleet",
      kind: "fleet-waiting",
      fleetSession,
    } as AttentionItem
    expect(sameOwner(attentionOwner(item)!, fleetSessionOwner(fleetSession))).toBe(true)
  })
})

describe("taskIdentity", () => {
  it("is null when nothing discriminating is known", () => {
    expect(taskIdentity({ kind: "team" })).toBeNull()
    expect(taskIdentity({ kind: "chat", sessionId: "" })).toBeNull()
  })

  it("separates two agents that share a session id", () => {
    expect(taskIdentity({ kind: "external", agent: "codex", sessionId: "x" })).not.toBe(
      taskIdentity({ kind: "external", agent: "opencode", sessionId: "x" })
    )
  })
})

describe("ownerRoute", () => {
  it("has no route for an external agent, whose owner is a terminal", () => {
    expect(ownerRoute({ kind: "external", agent: "codex", sessionId: "x" })).toBeNull()
  })

  it("encodes ids into the route", () => {
    expect(ownerRoute({ kind: "run", runId: "a b" })).toBe("/agent-runs?run=a%20b")
    expect(ownerRoute({ kind: "team", teamId: "t/1" })).toBe("/squads?id=t%2F1")
    expect(ownerRoute({ kind: "team" })).toBe("/squads")
    expect(ownerRoute({ kind: "chat", sessionId: "s" })).toBe("/")
  })
})
