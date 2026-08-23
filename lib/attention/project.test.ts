import { projectAttention, sortAttention, liveAttentionCount } from "./project"
import { actionReviewInterruptId } from "@/lib/policy/action-review/projection"
import type { AttentionItem } from "./types"
import type { ExecutionRunInterrupt } from "@/types/execution/run"
import type { PendingApproval } from "@cognia/agent-config-types"
import type { PendingGate } from "@/stores/agent/pending-gates-store"
import type { FleetSession, FleetSnapshot } from "@/lib/fleet/types"

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  sessionId: "s1",
  requestId: "r1",
  toolUseID: "tu1",
  toolName: "Bash",
  input: {},
  requestedAt: 100,
  ...over,
})

const gate = (over: Partial<PendingGate> = {}): PendingGate => ({
  key: { scope: "agent-team-budget", id: "run-1" },
  gateType: "budget",
  title: "Budget gate",
  runId: "run-1",
  teamId: "team-1",
  openedAt: 200,
  status: "open",
  ...over,
})

const fleetSession = (over: Partial<FleetSession> = {}): FleetSession =>
  ({
    agent: "claude-code",
    sessionId: "f1",
    status: "working",
    cwd: null,
    projectName: "proj",
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: true,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
    },
    startedAt: 1,
    lastEventAt: 300,
    ...over,
  }) as FleetSession

const emptyFleet: FleetSnapshot = { sessions: [], generatedAt: 0 }

describe("projectAttention", () => {
  it("returns an empty list for empty inputs", () => {
    expect(projectAttention({ chatSessions: {}, gates: [], fleet: emptyFleet })).toEqual([])
  })

  it("projects chat approvals with the bucketed session id", () => {
    const items = projectAttention({
      chatSessions: { bucket: { pendingApprovals: [approval()] } },
      gates: [],
      fleet: emptyFleet,
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "chat:r1",
      source: "chat",
      kind: "tool-approval",
      title: "Bash",
      sessionId: "bucket",
      openedAt: 100,
      stale: false,
    })
  })

  it("labels a subagent-origin approval with the asking subagent", () => {
    const items = projectAttention({
      chatSessions: {
        chat: {
          pendingApprovals: [approval({ origin: "subagent", subagentId: "explore" })],
        },
      },
      gates: [],
      fleet: emptyFleet,
    })
    expect(items[0].title).toBe("explore · Bash")
  })

  it("surfaces journal-only entries as stale items, skipping live/settled ones", () => {
    const items = projectAttention({
      chatSessions: { chat: { pendingApprovals: [approval({ requestId: "live" })] } },
      gates: [],
      fleet: emptyFleet,
      approvalJournal: [
        {
          requestId: "live", // present in a live slice → skipped
          sessionId: "eph",
          bucketSessionId: "chat",
          toolName: "Bash",
          requestedAt: 1,
          status: "interrupted",
        },
        {
          requestId: "ghost", // not live → surfaced stale
          sessionId: "eph2",
          bucketSessionId: "chat",
          toolName: "Read",
          origin: "subagent",
          subagentId: "explore",
          requestedAt: 2,
          status: "interrupted",
        },
        {
          requestId: "done", // settled → skipped
          sessionId: "eph3",
          bucketSessionId: "chat",
          toolName: "Grep",
          requestedAt: 3,
          status: "settled",
        },
      ],
    })
    const journalItem = items.find((i) => i.id === "chat:ghost")
    expect(journalItem).toMatchObject({ stale: true, title: "explore · Read", sessionId: "chat" })
    expect(items.filter((i) => i.id === "chat:live")).toHaveLength(1) // only the live one
    expect(items.find((i) => i.id === "chat:done")).toBeUndefined()
  })

  it("marks interrupted approvals and gates stale", () => {
    const items = projectAttention({
      chatSessions: { s1: { pendingApprovals: [approval({ status: "interrupted" })] } },
      gates: [gate({ status: "interrupted" })],
      fleet: emptyFleet,
    })
    expect(items.every((i) => i.stale)).toBe(true)
  })

  it("projects team gates with team/run refs", () => {
    const items = projectAttention({ chatSessions: {}, gates: [gate()], fleet: emptyFleet })
    expect(items[0]).toMatchObject({
      id: "team:agent-team-budget:run-1",
      source: "team",
      kind: "hitl-gate",
      teamId: "team-1",
      runId: "run-1",
      stale: false,
    })
  })

  it("projects a fleet pending permission ahead of plan-pending/waiting-input", () => {
    const items = projectAttention({
      chatSessions: {},
      gates: [],
      fleet: {
        generatedAt: 1,
        sessions: [
          fleetSession({ sessionId: "w", status: "plan-pending", lastEventAt: 1 }),
          fleetSession({
            sessionId: "p",
            status: "waiting-permission",
            pendingPermission: { requestId: "pr", toolName: "bash", detail: null, requestedAt: 5 },
          }),
        ],
      },
    })
    expect(items.map((i) => i.kind)).toEqual(["fleet-permission", "fleet-waiting"])
  })

  it("prefers the parked question, then the plan headline, as the waiting detail", () => {
    const items = projectAttention({
      chatSessions: {},
      gates: [],
      fleet: {
        generatedAt: 1,
        sessions: [
          fleetSession({
            sessionId: "q",
            status: "waiting-input",
            lastPrompt: "do the thing",
            pendingQuestions: [
              { question: "Which auth method?", options: ["OAuth"], multiSelect: false },
            ],
          }),
          fleetSession({
            sessionId: "pl",
            status: "plan-pending",
            lastPrompt: "plan it",
            pendingPlan: "\n## Migration plan\n1. step",
          }),
          fleetSession({
            sessionId: "fallback",
            status: "waiting-input",
            lastPrompt: "just a prompt",
          }),
        ],
      },
    })
    const byId = new Map(items.map((i) => [i.id.split(":").at(-1), i.detail]))
    expect(byId.get("q")).toBe("Which auth method?")
    expect(byId.get("pl")).toBe("## Migration plan")
    expect(byId.get("fallback")).toBe("just a prompt")
  })

  it("ignores idle/working/ended fleet sessions", () => {
    const items = projectAttention({
      chatSessions: {},
      gates: [],
      fleet: {
        generatedAt: 1,
        sessions: [
          fleetSession({ status: "working" }),
          fleetSession({ sessionId: "f2", status: "idle" }),
          fleetSession({ sessionId: "f3", status: "ended" }),
        ],
      },
    })
    expect(items).toEqual([])
  })
})

describe("sortAttention", () => {
  const item = (over: Partial<AttentionItem>): AttentionItem => ({
    id: "x",
    source: "chat",
    kind: "tool-approval",
    title: "t",
    openedAt: 0,
    stale: false,
    ...over,
  })

  it("orders live fleet-permission → tool-approval → hitl-gate → fleet-waiting → stale", () => {
    const sorted = sortAttention([
      item({ id: "stale", kind: "tool-approval", stale: true }),
      item({ id: "wait", kind: "fleet-waiting" }),
      item({ id: "gate", kind: "hitl-gate" }),
      item({ id: "appr", kind: "tool-approval" }),
      item({ id: "perm", kind: "fleet-permission" }),
    ])
    expect(sorted.map((i) => i.id)).toEqual(["perm", "appr", "gate", "wait", "stale"])
  })

  it("breaks ties by openedAt ascending (oldest first)", () => {
    const sorted = sortAttention([
      item({ id: "new", openedAt: 200 }),
      item({ id: "old", openedAt: 100 }),
    ])
    expect(sorted.map((i) => i.id)).toEqual(["old", "new"])
  })

  it("does not mutate its input", () => {
    const input = [item({ id: "b", openedAt: 2 }), item({ id: "a", openedAt: 1 })]
    sortAttention(input)
    expect(input.map((i) => i.id)).toEqual(["b", "a"])
  })
})

describe("liveAttentionCount", () => {
  it("counts only non-stale items", () => {
    const items = projectAttention({
      chatSessions: {
        s1: {
          pendingApprovals: [approval(), approval({ requestId: "r2", status: "interrupted" })],
        },
      },
      gates: [],
      fleet: emptyFleet,
    })
    expect(liveAttentionCount(items)).toBe(1)
  })
})

const interrupt = (over: Partial<ExecutionRunInterrupt> = {}): ExecutionRunInterrupt => ({
  id: "i1",
  runId: "run-9",
  type: "tool_approval",
  status: "pending",
  title: "Bash",
  expiresAt: 10_000,
  createdAt: 300,
  ...over,
})

describe("durable run approvals", () => {
  const base = { chatSessions: {}, gates: [], fleet: emptyFleet }

  it("surfaces a pending run interrupt with its run id", () => {
    const [item] = projectAttention({ ...base, runInterrupts: [interrupt()] }, 1_000)
    expect(item).toMatchObject({
      id: "run:i1",
      source: "run",
      kind: "run-approval",
      title: "Bash",
      runId: "run-9",
      stale: false,
    })
  })

  it("ignores an interrupt that was already answered", () => {
    const items = projectAttention(
      {
        ...base,
        runInterrupts: [
          interrupt({ id: "a", status: "approved" }),
          interrupt({ id: "b", status: "denied" }),
          interrupt({ id: "c", status: "expired" }),
        ],
      },
      1_000
    )
    expect(items).toEqual([])
  })

  /** A pending row past its deadline has not been swept yet; it is not answerable. */
  it("marks a past-deadline interrupt stale rather than offering it as live", () => {
    const items = projectAttention(
      { ...base, runInterrupts: [interrupt({ expiresAt: 500 })] },
      1_000
    )
    expect(items[0].stale).toBe(true)
    expect(liveAttentionCount(items)).toBe(0)
  })

  /**
   * A chat tool approval also parks its run on an interrupt. Both describe the
   * same thing waiting on the same person; only the chat row can answer it
   * inline, so the durable twin must not be listed beside it.
   */
  it("does not list a chat approval twice when its run interrupt exists too", () => {
    const items = projectAttention(
      {
        ...base,
        chatSessions: { s1: { pendingApprovals: [approval({ requestId: "req-7" })] } },
        runInterrupts: [interrupt({ id: actionReviewInterruptId("req-7") })],
      },
      1_000
    )
    expect(items).toHaveLength(1)
    expect(items[0].source).toBe("chat")
  })

  /** The dedupe is by request, not by "any interrupt exists". */
  it("keeps a run interrupt whose chat approval is NOT live here", () => {
    const items = projectAttention(
      {
        ...base,
        chatSessions: { s1: { pendingApprovals: [approval({ requestId: "req-7" })] } },
        runInterrupts: [interrupt({ id: actionReviewInterruptId("req-other") })],
      },
      1_000
    )
    expect(items.map((i) => i.source).sort()).toEqual(["chat", "run"])
  })

  it("keeps an interrupt that did not come from a review at all", () => {
    const items = projectAttention(
      { ...base, runInterrupts: [interrupt({ id: "handoff:42", type: "human_handoff" })] },
      1_000
    )
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("run:handoff:42")
  })

  it("ranks a run approval alongside a chat approval and ahead of a team gate", () => {
    const items = projectAttention(
      {
        ...base,
        gates: [gate()],
        runInterrupts: [interrupt()],
      },
      1_000
    )
    expect(items.map((i) => i.kind)).toEqual(["run-approval", "hitl-gate"])
  })
})
