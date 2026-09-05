import type { AttentionItem } from "@/lib/attention/types"
import type { FleetSession, FleetSnapshot } from "@/lib/fleet/types"
import { projectIslandState, sortIslandRows } from "./projection"
import { ISLAND_DONE_LINGER_MS, type IslandRowProjection } from "./types"

const NOW = 1_000_000

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
    cwd: "/Users/me/secret-project",
    projectName: "proj",
    lastPrompt: "rm -rf /Users/me/secret",
    activity: { toolName: "Bash", detail: "pnpm test --filter secret" },
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: true,
      sendMessage: false,
      focusTerminal: true,
      openTranscript: false,
      interrupt: true,
    },
    startedAt: NOW - 5000,
    lastEventAt: NOW - 1000,
    toolUseCount: 1,
    turnCount: 1,
    ...overrides,
  }
}

function snapshot(sessions: FleetSession[]): FleetSnapshot {
  return { sessions, generatedAt: NOW }
}

function project(
  sessions: FleetSession[],
  attention: AttentionItem[] = [],
  visibility: "click-to-reveal" | "hover" | "summary-only" = "click-to-reveal"
) {
  return projectIslandState(
    {
      fleet: snapshot(sessions),
      attention,
      detailVisibility: visibility,
      epoch: 1,
      revision: 7,
    },
    NOW
  )
}

describe("projectIslandState privacy", () => {
  it("keeps prompts, paths and command arguments out of the projection", () => {
    const state = project([session()])
    const serialized = JSON.stringify(state)
    expect(serialized).not.toContain("secret-project")
    expect(serialized).not.toContain("rm -rf")
    expect(serialized).not.toContain("pnpm test")
    // The tool NAME is safe and is what the summary carries.
    expect(state.rows[0].summary).toBe("Bash")
  })

  it("refuses detail entirely under summary-only", () => {
    expect(project([session()], [], "summary-only").rows[0].capabilities.detail).toBe(false)
    expect(project([session()], [], "hover").rows[0].capabilities.detail).toBe(true)
  })
})

describe("projectIslandState capabilities", () => {
  it("never offers interrupt for a cognia session", () => {
    const state = project([
      session({
        agent: "cognia",
        sessionId: "chat-1",
        capabilities: {
          approvePermission: false,
          sendMessage: false,
          focusTerminal: true,
          openTranscript: true,
          // Even a snapshot that claims it.
          interrupt: true,
        },
      }),
    ])
    expect(state.rows[0].capabilities.interrupt).toBe(false)
    expect(state.rows[0].capabilities.focusTerminal).toBe(false)
    expect(state.rows[0].capabilities.openOwner).toBe(true)
  })

  it("offers a permission decision only when the ingress can carry one back", () => {
    const pending = { requestId: "p1", toolName: "Bash", detail: "x", requestedAt: NOW }
    const capable = project([session({ status: "waiting-permission", pendingPermission: pending })])
    expect(capable.rows[0].capabilities.permissionDecision).toBe(true)

    const observed = project([
      session({
        status: "waiting-permission",
        pendingPermission: pending,
        capabilities: {
          approvePermission: false,
          sendMessage: false,
          focusTerminal: false,
          openTranscript: false,
          interrupt: false,
        },
      }),
    ])
    expect(observed.rows[0].capabilities.permissionDecision).toBe(false)
    expect(observed.rows[0].permission).toBeDefined()
  })
})

describe("projectIslandState merging", () => {
  const fleetSession = session({ agent: "opencode", sessionId: "oc", status: "waiting-input" })

  it("folds an attention item into the session row that shares its identity", () => {
    const item = {
      id: "fleet:opencode:oc",
      source: "fleet",
      kind: "fleet-waiting",
      title: "proj",
      openedAt: NOW - 30_000,
      stale: false,
      fleetSession,
    } as AttentionItem
    const state = project([fleetSession], [item])
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0].waitingSince).toBe(NOW - 30_000)
  })

  it("keeps an item it cannot prove is the same task as its own row", () => {
    const item = {
      id: "chat:req",
      source: "chat",
      kind: "tool-approval",
      title: "proj",
      openedAt: NOW,
      stale: false,
      sessionId: "some-chat",
    } as AttentionItem
    expect(project([fleetSession], [item]).rows).toHaveLength(2)
  })
})

describe("stale dismissal", () => {
  function staleItem(over: Record<string, unknown>): AttentionItem {
    return {
      title: "t",
      openedAt: NOW,
      stale: true,
      ...over,
    } as AttentionItem
  }

  it("offers Dismiss only when the clearing call has the id it needs", () => {
    const withRequest = project(
      [],
      [
        staleItem({
          id: "chat:req",
          source: "chat",
          kind: "tool-approval",
          sessionId: "s",
          approval: { requestId: "req" },
        }),
      ]
    )
    expect(withRequest.rows[0].capabilities.dismissStale).toBe(true)

    // A journal-only entry has no live approval, so there is no request id to
    // clear and the button would only ever fail.
    const withoutRequest = project(
      [],
      [staleItem({ id: "chat:x", source: "chat", kind: "tool-approval", sessionId: "s" })]
    )
    expect(withoutRequest.rows[0].capabilities.dismissStale).toBe(false)
  })

  it("never offers Dismiss for a human handoff or a fleet row", () => {
    const handoff = project(
      [],
      [
        staleItem({
          id: "run:r1",
          source: "run",
          kind: "run-approval",
          runId: "r1",
          interrupt: { id: "i1", runId: "r1", type: "human_handoff" },
        }),
      ]
    )
    expect(handoff.rows[0].capabilities.dismissStale).toBe(false)

    const fleetRow = project(
      [],
      [
        staleItem({
          id: "fleet:codex:x",
          source: "fleet",
          kind: "fleet-waiting",
          fleetSession: session({ agent: "codex", sessionId: "x" }),
        }),
      ]
    )
    expect(fleetRow.rows[0].capabilities.dismissStale).toBe(false)
  })
})

describe("projectIslandState lifecycle", () => {
  it("keeps a finished session for the linger window and drops it after", () => {
    const justEnded = session({ status: "ended", lastEventAt: NOW - 1_000 })
    expect(project([justEnded]).rows).toHaveLength(1)
    const longEnded = session({ status: "ended", lastEventAt: NOW - ISLAND_DONE_LINGER_MS - 1 })
    expect(project([longEnded]).rows).toHaveLength(0)
  })

  it("counts only blocked rows as attention and blocked plus working as active", () => {
    const state = project([
      session({ sessionId: "a", status: "waiting-permission" }),
      session({ sessionId: "b", status: "working" }),
      session({ sessionId: "c", status: "idle" }),
    ])
    expect(state.attentionCount).toBe(1)
    expect(state.activeCount).toBe(2)
    expect(state.revision).toBe(7)
  })
})

describe("sortIslandRows", () => {
  function row(over: Partial<IslandRowProjection>): IslandRowProjection {
    return {
      id: "x",
      source: "external",
      owner: { kind: "external", agent: "codex", sessionId: "x" },
      status: "working",
      priority: 2,
      title: "t",
      summary: "",
      startedAt: 0,
      updatedAt: 0,
      capabilities: {
        openOwner: false,
        permissionDecision: false,
        questionResponse: false,
        reply: false,
        interrupt: false,
        focusTerminal: false,
        openTranscript: false,
        dismissStale: false,
        detail: false,
      },
      stale: false,
      ...over,
    }
  }

  it("orders blocked, failed, working, done, idle, stale", () => {
    const sorted = sortIslandRows([
      row({ id: "stale", status: "stale", priority: 5 }),
      row({ id: "idle", status: "idle", priority: 4 }),
      row({ id: "done", status: "done", priority: 3 }),
      row({ id: "working", status: "working", priority: 2 }),
      row({ id: "failed", status: "failed", priority: 1 }),
      row({ id: "blocked", status: "blocked", priority: 0 }),
    ])
    expect(sorted.map((r) => r.id)).toEqual([
      "blocked",
      "failed",
      "working",
      "done",
      "idle",
      "stale",
    ])
  })

  it("puts the longest human wait first among blocked rows", () => {
    const sorted = sortIslandRows([
      row({ id: "recent", status: "blocked", priority: 0, waitingSince: 500 }),
      row({ id: "oldest", status: "blocked", priority: 0, waitingSince: 100 }),
    ])
    expect(sorted[0].id).toBe("oldest")
  })

  it("puts the most recent update first among active rows", () => {
    const sorted = sortIslandRows([
      row({ id: "old", status: "working", priority: 2, updatedAt: 100 }),
      row({ id: "new", status: "working", priority: 2, updatedAt: 900 }),
    ])
    expect(sorted[0].id).toBe("new")
  })
})

describe("projectIslandState cognia sources", () => {
  it("projects a blocked Cognia session as open-only (deliberate dormancy)", () => {
    // Pinned on purpose: approve/deny and question answering are only proven
    // for external agents today. See IslandRowCapabilities.
    const state = project([
      session({
        agent: "cognia",
        sessionId: "chat-1",
        status: "waiting-permission",
        pendingPermission: { requestId: "p1", toolName: "Bash", requestedAt: NOW, detail: null },
        capabilities: {
          approvePermission: false,
          sendMessage: false,
          focusTerminal: false,
          openTranscript: false,
          interrupt: false,
        },
      }),
    ])
    expect(state.rows[0].status).toBe("blocked")
    expect(state.rows[0].capabilities).toMatchObject({
      openOwner: true,
      permissionDecision: false,
      questionResponse: false,
      reply: false,
      interrupt: false,
    })
  })

  it("never titles a Cognia row with its session UUID", () => {
    const unnamed = session({
      agent: "cognia",
      sessionId: "0f3a9c2e-7b1d-4c5e-9a1b-2d3e4f5a6b7c",
      projectName: null,
    })
    const alone = project([unnamed])
    expect(alone.rows[0].title).toBe("cognia")

    // An attention item folded into the same task supplies the human title.
    const item = {
      id: "chat:req",
      source: "chat",
      kind: "tool-approval",
      title: "Approve Bash",
      openedAt: NOW,
      stale: false,
      sessionId: unnamed.sessionId,
      approval: { requestId: "req" },
    } as AttentionItem
    const named = project([unnamed], [item])
    expect(named.rows).toHaveLength(1)
    expect(named.rows[0].title).toBe("Approve Bash")
  })
})

describe("mergeRows liveness and clearing ids", () => {
  it("lets a live session outrank a stale attention entry and keeps the request id", () => {
    const live = session({ agent: "cognia", sessionId: "s", status: "working" })
    const lingering = {
      id: "chat:req",
      source: "chat",
      kind: "tool-approval",
      title: "t",
      openedAt: NOW - 60_000,
      stale: true,
      sessionId: "s",
      approval: { requestId: "req" },
    } as AttentionItem
    const state = project([live], [lingering])
    expect(state.rows).toHaveLength(1)
    const row = state.rows[0]
    // The task is demonstrably still running: not relabelled stale, still counted.
    expect(row.status).toBe("working")
    expect(row.stale).toBe(false)
    expect(state.activeCount).toBe(1)
    // The merged owner carries the id the main window needs to clear the wait.
    expect(row.owner).toEqual({ kind: "chat", sessionId: "s", requestId: "req" })
  })

  it("offers Dismiss on a merged stale row only with an owner that can clear it", () => {
    const ended = session({ agent: "cognia", sessionId: "s", status: "ended" })
    const stale = {
      id: "chat:req",
      source: "chat",
      kind: "tool-approval",
      title: "t",
      openedAt: NOW,
      stale: true,
      sessionId: "s",
      approval: { requestId: "req" },
    } as AttentionItem
    const row = project([ended], [stale]).rows[0]
    expect(row.status).toBe("stale")
    expect(row.capabilities.dismissStale).toBe(true)
    expect(row.owner).toMatchObject({ kind: "chat", requestId: "req" })
  })
})
