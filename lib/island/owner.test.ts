import type { AttentionItem } from "@/lib/attention/types"
import {
  __resetExternalApprovalsForTests,
  registerExternalApproval,
} from "@/lib/ai/agent/external/session/chat-decision-bridge"
import {
  __resetAcpSessionRegistryForTests,
  registerAcpSession,
} from "@/lib/fleet/acp-session-registry"
import type { FleetSession } from "@/lib/fleet/types"
import type { ExternalAgentPermissionRequestEvent } from "@/types/agent/external-agent"
import {
  attentionOwner,
  fleetSessionOwner,
  ownerRoute,
  ownerSource,
  sameOwner,
  taskIdentity,
} from "./owner"
import type { FleetOwnerRef } from "./types"

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
  it.each([
    [{ agentTeamId: "team" }, { kind: "team", teamId: "team" }],
    [{ agentTeamRunId: "run" }, { kind: "team", runId: "run" }],
  ])("keeps partially known team identity instead of falling back to chat", (fields, expected) => {
    expect(fleetSessionOwner(session({ agent: "cognia", ...fields }))).toEqual(expected)
  })
  it("routes an external CLI to its own session", () => {
    const owner = fleetSessionOwner(session({ agent: "codex", transcriptPath: "/t.jsonl" }))
    expect(owner).toEqual({
      kind: "external",
      agent: "codex",
      sessionId: "s1",
      transcriptPath: "/t.jsonl",
    })
  })

  it("carries the manager identity of a renderer-managed ACP session", () => {
    const owner = fleetSessionOwner(
      session({
        agent: "devin",
        sessionId: "ext-1",
        externalAgentId: "agent-1",
        chatSessionId: "chat-9",
      })
    )
    expect(owner).toEqual({
      kind: "external",
      agent: "devin",
      sessionId: "ext-1",
      agentId: "agent-1",
      chatSessionId: "chat-9",
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

  it.each(["chat", "team", "run", "fleet"] as const)(
    "does not invent an owner for a %s item missing its source identity",
    (source) => {
      expect(
        attentionOwner({ ...base, id: "orphan", kind: "tool-approval", source } as AttentionItem)
      ).toBeNull()
    }
  )

  it.each([
    [
      { source: "team", teamId: "t" },
      { kind: "team", teamId: "t" },
    ],
    [
      { source: "team", runId: "r" },
      { kind: "team", runId: "r" },
    ],
    [
      { source: "team", teamId: "t", runId: "r" },
      { kind: "team", teamId: "t", runId: "r" },
    ],
    [
      { source: "run", runId: "r" },
      { kind: "run", runId: "r" },
    ],
    [
      { source: "run", runId: "r", interrupt: { id: "i" } },
      { kind: "run", runId: "r", interruptId: "i" },
    ],
  ])("preserves the ids required to open and clear an attention owner", (fields, expected) => {
    expect(
      attentionOwner({ ...base, id: "pending", kind: "run-approval", ...fields } as AttentionItem)
    ).toEqual(expected)
  })

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

  it("folds an external approval into its ACP session owner instead of a second row", () => {
    __resetExternalApprovalsForTests()
    __resetAcpSessionRegistryForTests()
    const event = {
      type: "permission_request",
      sessionId: "ext-1",
      timestamp: new Date(0),
      request: { id: "r1", requestId: "r1", sessionId: "ext-1", toolInfo: { name: "Bash" } },
    } as ExternalAgentPermissionRequestEvent
    const approval = registerExternalApproval({
      agentId: "agent-1",
      chatSessionId: "chat-9",
      event,
    })
    registerAcpSession("ext-1", { agent: "devin", agentId: "agent-1" })
    const item = {
      ...base,
      id: "chat:req",
      source: "chat",
      kind: "tool-approval",
      sessionId: "chat-9",
      approval: { requestId: approval!.requestId },
    } as unknown as AttentionItem

    const owner = attentionOwner(item)
    expect(owner).toEqual({
      kind: "external",
      agent: "devin",
      sessionId: "ext-1",
      agentId: "agent-1",
      chatSessionId: "chat-9",
    })
    // The folded owner is the same identity the session row produced.
    expect(taskIdentity(owner!)).toBe("external:devin:ext-1")
    __resetExternalApprovalsForTests()
    __resetAcpSessionRegistryForTests()
  })

  it("keeps a chat owner when the ACP session was never registered", () => {
    __resetExternalApprovalsForTests()
    __resetAcpSessionRegistryForTests()
    const event = {
      type: "permission_request",
      sessionId: "ext-gone",
      timestamp: new Date(0),
      request: { id: "r2", requestId: "r2", sessionId: "ext-gone", toolInfo: { name: "Bash" } },
    } as ExternalAgentPermissionRequestEvent
    const approval = registerExternalApproval({
      agentId: "agent-1",
      chatSessionId: "chat-9",
      event,
    })
    const item = {
      ...base,
      id: "chat:req",
      source: "chat",
      kind: "tool-approval",
      sessionId: "chat-9",
      approval: { requestId: approval!.requestId },
    } as unknown as AttentionItem
    expect(attentionOwner(item)).toEqual({
      kind: "chat",
      sessionId: "chat-9",
      requestId: approval!.requestId,
    })
    __resetExternalApprovalsForTests()
  })

  it("returns null when the discriminating id is missing", () => {
    const item = { ...base, id: "team::", source: "team", kind: "hitl-gate" } as AttentionItem
    expect(attentionOwner(item)).toBeNull()
  })

  it.each([undefined, "chat-7"])("preserves a plan gate with session %s", (sessionId) => {
    const item = {
      ...base,
      id: "team:agent-plan:plan-step",
      source: "team",
      kind: "hitl-gate",
      gate: {
        key: { scope: "agent-plan", id: "plan-step" },
        gateType: "plan_step",
        title: "Review plan",
        planId: "plan-1",
        sessionId,
        openedAt: 1,
        status: "open",
      },
    } as AttentionItem
    const owner = attentionOwner(item)
    expect(owner).toEqual({
      kind: "gate",
      gateKey: item.gate!.key,
      ...(sessionId ? { sessionId } : {}),
    })
    expect(ownerRoute(owner!)).toBe("/")
  })

  it("opens the global approval host for budget gates, not a fabricated team", () => {
    const item = {
      ...base,
      id: "team:cost-budget:global:daily",
      source: "team",
      kind: "hitl-gate",
      runId: "global:daily",
      gate: {
        key: { scope: "cost-budget", id: "global:daily" },
        gateType: "budget",
        title: "Daily budget",
        runId: "global:daily",
        openedAt: 1,
        status: "open",
      },
    } as AttentionItem
    const owner = attentionOwner(item)
    expect(owner?.kind).toBe("gate")
    expect(ownerRoute(owner!)).toBe("/")
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
  it.each([
    { kind: "run", runId: "" },
    { kind: "external", agent: "codex", sessionId: "" },
    { kind: "gate", gateKey: { scope: "plan", id: "" } },
  ] satisfies FleetOwnerRef[])("does not merge owners missing a required identity: %j", (owner) => {
    expect(taskIdentity(owner)).toBeNull()
    expect(sameOwner(owner, owner)).toBe(false)
  })

  it.each([
    { kind: "chat", sessionId: "s" },
    { kind: "team", teamId: "t" },
    { kind: "team", runId: "r" },
    { kind: "run", runId: "r" },
    { kind: "gate", gateKey: { scope: "plan", id: "g" } },
    { kind: "external", agent: "codex", sessionId: "s" },
  ] satisfies FleetOwnerRef[])("classifies and recognizes each owner kind: %j", (owner) => {
    expect(ownerSource(owner)).toBe(owner.kind)
    expect(sameOwner(owner, { ...owner })).toBe(true)
    expect(sameOwner(owner, { kind: "chat", sessionId: "different" })).toBe(false)
  })
  it("keeps gate keys distinct even when their scopes and ids contain separators", () => {
    expect(taskIdentity({ kind: "gate", gateKey: { scope: "a:b", id: "c" } })).not.toBe(
      taskIdentity({ kind: "gate", gateKey: { scope: "a", id: "b:c" } })
    )
    expect(taskIdentity({ kind: "gate", gateKey: { scope: "", id: "c" } })).toBeNull()
  })
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

  it("routes a renderer-managed ACP session to its chat or the agents page", () => {
    expect(
      ownerRoute({
        kind: "external",
        agent: "devin",
        sessionId: "x",
        agentId: "agent-1",
        chatSessionId: "chat-9",
      })
    ).toBe("/")
    expect(ownerRoute({ kind: "external", agent: "acp", sessionId: "x", agentId: "agent-1" })).toBe(
      "/me/external-agents"
    )
  })

  it("encodes ids into the route", () => {
    expect(ownerRoute({ kind: "run", runId: "a b" })).toBe("/agent-runs?run=a%20b")
    expect(ownerRoute({ kind: "team", teamId: "t/1" })).toBe("/squads?id=t%2F1")
    expect(ownerRoute({ kind: "team" })).toBe("/squads")
    expect(ownerRoute({ kind: "chat", sessionId: "s" })).toBe("/")
  })
})
