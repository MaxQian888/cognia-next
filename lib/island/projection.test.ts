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
  it("bounds display metadata and omits permission command bodies", () => {
    const row = project([
      session({
        hostRef: "host-".repeat(20),
        terminal: { app: "iterm", label: "Terminal ".repeat(10) },
        pendingPermission: {
          requestId: "p",
          toolName: null,
          detail: "secret command",
          requestedAt: NOW,
        },
        pendingQuestionRequest: { requestId: "q", requestedAt: NOW },
        pendingQuestions: [
          {
            question: "Question ".repeat(40),
            header: "Heading ".repeat(10),
            options: ["Option ".repeat(20)],
            multiSelect: true,
          },
        ],
      }),
    ]).rows[0]
    expect(row.hostRef!.length).toBeLessThanOrEqual(32)
    expect(row.terminal!.label.length).toBeLessThanOrEqual(24)
    expect(row.permission).toEqual({ requestId: "p", toolName: null, requestedAt: NOW })
    expect(row.question!.questions[0]).toMatchObject({ multiSelect: true })
    expect(row.question!.questions[0].question.length).toBeLessThanOrEqual(200)
    expect(row.question!.questions[0].header!.length).toBeLessThanOrEqual(24)
    expect(row.question!.questions[0].options[0].length).toBeLessThanOrEqual(48)
    expect(JSON.stringify(row)).not.toContain("secret command")
  })

  it("uses safe fallbacks when a session has no title, activity, or terminal label", () => {
    const row = project([
      session({ projectName: null, activity: null, terminal: { app: "iterm", label: "" } }),
    ]).rows[0]
    expect(row.title).toBe("s1")
    expect(row.summary).toBe("")
    expect(row.terminal).toEqual({ app: "iterm", label: "iterm" })
  })
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
  it("requires both a transcript capability and a path before offering Open transcript", () => {
    const capabilities = { ...session().capabilities, openTranscript: true, sendMessage: true }
    const available = project([session({ capabilities, transcriptPath: "/transcript" })]).rows[0]
    expect(available.capabilities).toMatchObject({ openTranscript: true, reply: true })
    expect(project([session({ capabilities })]).rows[0].capabilities.openTranscript).toBe(false)
  })

  it("keeps questions display-only without a parked handle and suppresses empty requests", () => {
    const question = { question: "Where?", options: ["Local"], multiSelect: false }
    const displayOnly = project([session({ pendingQuestions: [question] })]).rows[0]
    expect(displayOnly.capabilities.questionResponse).toBe(false)
    expect(displayOnly.question).toBeUndefined()
    const empty = project([
      session({ pendingQuestionRequest: { requestId: "q", requestedAt: NOW } }),
    ]).rows[0]
    expect(empty.capabilities.questionResponse).toBe(false)
    expect(empty.question).toBeUndefined()
    const waiting = project([
      session({
        status: "waiting-input",
        pendingQuestionRequest: { requestId: "q", requestedAt: NOW },
        pendingQuestions: [question],
      }),
    ]).rows[0]
    expect(waiting.statusKey).toBe("awaitingInput")
  })
  const question = {
    question: "Choose a destination",
    options: ["Local", "Remote"],
    multiSelect: false,
  }

  it("offers inline answers only when every question and option fits the projection", () => {
    const pending = { requestId: "q1", requestedAt: NOW }
    const complete = project([
      session({ pendingQuestionRequest: pending, pendingQuestions: Array(4).fill(question) }),
    ]).rows[0]
    expect(complete.capabilities.questionResponse).toBe(true)

    for (const questions of [
      Array(5).fill(question),
      [{ ...question, options: Array.from({ length: 9 }, (_, index) => `Option ${index}`) }],
      [{ ...question, options: [] }],
    ]) {
      const row = project([
        session({ pendingQuestionRequest: pending, pendingQuestions: questions }),
      ]).rows[0]
      expect(row.capabilities.questionResponse).toBe(false)
      expect(row.capabilities.focusTerminal).toBe(true)
    }
  })

  it.each(["ended", "detached"] as const)(
    "does not offer gate decisions or runtime controls for a %s session",
    (status) => {
      const row = project([
        session({
          status,
          pendingPermission: { requestId: "p1", toolName: "Bash", requestedAt: NOW, detail: null },
          pendingQuestionRequest: { requestId: "q1", requestedAt: NOW },
          pendingQuestions: [question],
          capabilities: { ...session().capabilities, sendMessage: true },
        }),
      ]).rows[0]
      expect(row.capabilities).toMatchObject({
        permissionDecision: false,
        questionResponse: false,
        reply: false,
        interrupt: false,
        focusTerminal: true,
      })
    }
  )

  it("does not route Cognia questions or replies through external Fleet controls", () => {
    const row = project([
      session({
        agent: "cognia",
        pendingPermission: { requestId: "p1", toolName: "Bash", requestedAt: NOW, detail: null },
        pendingQuestionRequest: { requestId: "q1", requestedAt: NOW },
        pendingQuestions: [question],
        capabilities: { ...session().capabilities, sendMessage: true },
      }),
    ]).rows[0]
    expect(row.capabilities).toMatchObject({
      openOwner: true,
      permissionDecision: false,
      questionResponse: false,
      reply: false,
    })
  })

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

describe("non-Squad approval gates", () => {
  it("keeps every plan gate visible separately from its chat and sibling gates", () => {
    const attention = ["step-a", "step-b"].map((id) => ({
      id: `team:agent-plan:${id}`,
      source: "team" as const,
      kind: "hitl-gate" as const,
      title: "Review plan",
      openedAt: NOW,
      stale: false,
      gate: {
        key: { scope: "agent-plan", id },
        gateType: "plan_step" as const,
        title: "Review plan",
        planId: "plan-1",
        sessionId: "chat-1",
        openedAt: NOW,
        status: "open" as const,
      },
    }))
    const state = project([session({ agent: "cognia", sessionId: "chat-1" })], attention)
    expect(state.rows).toHaveLength(3)
    expect(state.attentionCount).toBe(2)
    expect(state.rows.filter((row) => row.source === "gate")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gate:agent-plan:step-a",
          capabilities: expect.objectContaining({ openOwner: true, dismissStale: false }),
        }),
        expect.objectContaining({ id: "gate:agent-plan:step-b" }),
      ])
    )
  })

  it("offers stale gate dismissal only for an interrupted gate", () => {
    for (const status of ["open", "interrupted"] as const) {
      const row = project(
        [],
        [
          {
            id: "team:agent-plan:step-a",
            source: "team",
            kind: "hitl-gate",
            title: "Review plan",
            openedAt: NOW,
            stale: true,
            gate: {
              key: { scope: "agent-plan", id: "step-a" },
              gateType: "plan_step",
              title: "Review plan",
              openedAt: NOW,
              status,
            },
          },
        ]
      ).rows[0]
      expect(row.capabilities.dismissStale).toBe(status === "interrupted")
    }
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

  it("permits clearing stale teams and non-handoff runs only with their clearing identity", () => {
    const state = project(
      [],
      [
        staleItem({ id: "team:t", source: "team", kind: "hitl-gate", teamId: "t" }),
        staleItem({ id: "team:r", source: "team", kind: "hitl-gate", runId: "r" }),
        staleItem({
          id: "run:r",
          source: "run",
          kind: "run-approval",
          runId: "r",
          interrupt: { id: "i", runId: "r", type: "tool_approval" },
        }),
        staleItem({ id: "run:missing", source: "run", kind: "run-approval", runId: "missing" }),
      ]
    )
    expect(
      state.rows
        .filter((row) => row.capabilities.dismissStale)
        .map((row) => row.id)
        .sort()
    ).toEqual(["run:r", "team::r", "team:t:"])
    expect(state.rows.find((row) => row.id === "run:missing")!.capabilities.dismissStale).toBe(
      false
    )
  })

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
  it("ignores observations with missing source identity instead of inventing a target", () => {
    const missing = {
      id: "orphan",
      source: "chat",
      kind: "tool-approval",
      title: "",
      openedAt: NOW,
      stale: false,
    } as AttentionItem
    const invalidGate = {
      ...missing,
      source: "team",
      kind: "hitl-gate",
      gate: { key: { scope: "plan", id: "" }, status: "open" },
    } as AttentionItem
    expect(project([session({ sessionId: "" })], [missing, invalidGate]).rows).toEqual([])
  })

  it.each(["working", "idle"] as const)(
    "marks a %s task failed without forwarding its error body",
    (status) => {
      const row = project([
        session({ status, lastError: { kind: "turn", at: NOW, detail: "sensitive failure" } }),
      ]).rows[0]
      expect(row.status).toBe("failed")
      expect(row.summary).toBe("")
      expect(JSON.stringify(row)).not.toContain("sensitive failure")
    }
  )

  it("uses the current clock by default and a source label for unnamed attention", () => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(NOW)
    try {
      const state = projectIslandState({
        fleet: snapshot([]),
        attention: [
          {
            id: "chat:q",
            source: "chat",
            kind: "tool-approval",
            sessionId: "s",
            title: "",
            openedAt: NOW,
            stale: false,
          } as AttentionItem,
        ],
        detailVisibility: "summary-only",
        epoch: 1,
        revision: 1,
      })
      expect(state.generatedAt).toBe(NOW)
      expect(state.rows[0]).toMatchObject({ title: "chat", capabilities: { detail: false } })
    } finally {
      clock.mockRestore()
    }
  })
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

  it("uses update times for unknown wait ages and stable ids to break exact ties", () => {
    const rows = [
      row({ id: "b", status: "blocked", priority: 0, updatedAt: 10 }),
      row({ id: "a", status: "blocked", priority: 0, updatedAt: 10 }),
      row({ id: "recent", status: "blocked", priority: 0, updatedAt: 20 }),
    ]
    expect(sortIslandRows(rows).map((row) => row.id)).toEqual(["a", "b", "recent"])
    expect(rows[0].id).toBe("b")
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
  it("preserves a run's interrupt identity when merging a detached session with its stale wait", () => {
    const detached = session({ agent: "cognia", executionRunId: "r", status: "detached" })
    const item = {
      id: "run:r",
      source: "run",
      kind: "run-approval",
      title: "Approval",
      runId: "r",
      openedAt: NOW,
      stale: true,
      interrupt: {
        id: "i",
        runId: "r",
        type: "tool_approval",
        status: "pending",
        title: "Approval",
        expiresAt: NOW + 60_000,
        createdAt: NOW,
      },
    } as AttentionItem
    const row = project([detached], [item]).rows[0]
    expect(row.owner).toMatchObject({ kind: "run", runId: "r", interruptId: "i" })
    expect(row).toMatchObject({ status: "stale", capabilities: { dismissStale: true } })
  })

  it("merges duplicate session observations while preserving their usable controls and oldest wait", () => {
    const basic = session({ status: "waiting-input", activity: null })
    const capable = session({
      status: "waiting-permission",
      lastEventAt: NOW - 500,
      pendingPermission: { requestId: "p", toolName: "Bash", detail: null, requestedAt: NOW },
      pendingQuestionRequest: { requestId: "q", requestedAt: NOW },
      pendingQuestions: [{ question: "Continue?", options: ["Yes"], multiSelect: false }],
      transcriptPath: "/transcript",
      capabilities: { ...session().capabilities, sendMessage: true, openTranscript: true },
    })
    const state = project([basic, capable])
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      waitingSince: basic.lastEventAt,
      updatedAt: capable.lastEventAt,
      permission: { requestId: "p" },
      question: { requestId: "q" },
      capabilities: {
        permissionDecision: true,
        questionResponse: true,
        reply: true,
        openTranscript: true,
      },
    })
  })
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

describe("projectIslandState ACP sessions", () => {
  it("carries the configured label and the manager identity into the row", () => {
    const row = project([
      session({
        agent: "acp",
        sessionId: "ext-1",
        projectName: null,
        agentLabel: "My Kiro",
        externalAgentId: "agent-1",
        chatSessionId: "chat-9",
      }),
    ]).rows[0]
    expect(row.agentLabel).toBe("My Kiro")
    expect(row.owner).toEqual({
      kind: "external",
      agent: "acp",
      sessionId: "ext-1",
      agentId: "agent-1",
      chatSessionId: "chat-9",
    })
    // A chat-bound ACP session opens its conversation, not a terminal.
    expect(row.capabilities.openOwner).toBe(true)
    // The label, not an opaque session id, is the title.
    expect(row.title).toBe("My Kiro")
  })

  it("offers permission, question, reply and interrupt controls on a live ACP row", () => {
    const row = project([
      session({
        agent: "devin",
        sessionId: "ext-1",
        status: "waiting-permission",
        pendingPermission: { requestId: "p1", toolName: "Bash", detail: null, requestedAt: NOW },
        capabilities: {
          approvePermission: true,
          sendMessage: true,
          focusTerminal: false,
          openTranscript: false,
          interrupt: true,
        },
      }),
    ]).rows[0]
    expect(row.capabilities).toMatchObject({
      permissionDecision: true,
      reply: true,
      interrupt: true,
      focusTerminal: false,
      openTranscript: false,
    })
  })

  it("blocks reply while a permission ask is open (the ask owns the turn)", () => {
    const row = project([
      session({
        agent: "acp",
        sessionId: "ext-1",
        status: "waiting-permission",
        pendingPermission: { requestId: "p1", toolName: "Bash", detail: null, requestedAt: NOW },
        capabilities: {
          approvePermission: true,
          sendMessage: false,
          focusTerminal: false,
          openTranscript: false,
          interrupt: true,
        },
      }),
    ]).rows[0]
    expect(row.status).toBe("blocked")
    expect(row.capabilities.reply).toBe(false)
    expect(row.capabilities.interrupt).toBe(true)
  })
})
