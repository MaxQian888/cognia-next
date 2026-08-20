import { reduceRunEvents } from "./run-reducer"
import type { ExecutionRun, ExecutionRunKind, RunEvent } from "@/types/execution/run"

const baseRun: ExecutionRun = {
  id: "run-1",
  kind: "workflow",
  sourceId: "workflow-run-1",
  title: "Publish release",
  status: "running",
  currentRevision: 0,
  startedAt: 1_000,
  updatedAt: 1_000,
}

function event(overrides: Partial<RunEvent> & Pick<RunEvent, "type" | "seq">): RunEvent {
  return {
    id: `event-${overrides.seq}`,
    runId: baseRun.id,
    ts: 1_000 + overrides.seq,
    visibility: "summary",
    payload: {},
    ...overrides,
  }
}

describe("reduceRunEvents", () => {
  it("stops at a journal gap so a later event cannot advance the revision", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({ type: "run.started", seq: 1 }),
      event({ type: "run.completed", seq: 3, payload: { summary: "must wait" } }),
    ])

    expect(snapshot.revision).toBe(1)
    expect(snapshot.status).toBe("running")
  })

  it("rebuilds a workflow snapshot deterministically from ordered semantic events", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({
        type: "plan.created",
        seq: 1,
        payload: {
          version: 1,
          steps: [
            { id: "build", title: "Build", status: "pending", safeTitle: true },
            { id: "publish", title: "Publish", status: "pending", safeTitle: true },
          ],
        },
      }),
      event({
        type: "step.started",
        seq: 2,
        payload: { stepId: "build", title: "Build", safeTitle: true },
      }),
      event({
        type: "step.completed",
        seq: 3,
        payload: {
          stepId: "build",
          title: "Build",
          summary: "Bundle ready",
          safeTitle: true,
          safeSummary: true,
        },
      }),
      event({
        type: "step.started",
        seq: 4,
        payload: { stepId: "publish", title: "Publish", safeTitle: true },
      }),
    ])

    expect(snapshot).toEqual(
      expect.objectContaining({
        runId: "run-1",
        status: "running",
        revision: 4,
        progress: { completed: 1, total: 2, ratio: 0.5, trustworthy: true },
        activeSteps: [expect.objectContaining({ id: "publish", status: "in_progress" })],
        recentSteps: [
          expect.objectContaining({ id: "build", status: "completed", summary: "Bundle ready" }),
        ],
      })
    )
  })

  it("ignores duplicates and stale events and never invents a percentage for dynamic agent runs", () => {
    const agentRun: ExecutionRun = { ...baseRun, kind: "agent-turn" }
    const events = [
      event({ type: "step.added", seq: 1, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.started", seq: 2, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.completed", seq: 3, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.failed", seq: 2, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.completed", seq: 3, payload: { stepId: "search", title: "Search" } }),
    ]

    const snapshot = reduceRunEvents(agentRun, events)

    expect(snapshot.revision).toBe(3)
    expect(snapshot.progress).toEqual({ completed: 1, total: 1, trustworthy: false })
    expect(snapshot.recentSteps[0]).toEqual(expect.objectContaining({ status: "completed" }))
  })

  it("keeps a terminal run terminal when later non-terminal events arrive", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({ type: "run.completed", seq: 1, payload: { summary: "Done" } }),
      event({ type: "run.resumed", seq: 2, payload: {} }),
      event({ type: "step.started", seq: 3, payload: { stepId: "late", title: "Late" } }),
    ])

    expect(snapshot.status).toBe("completed")
    expect(snapshot.summary).toBe("Run completed")
    expect(snapshot.allowedActions).toEqual(["open_details"])
  })

  it("offers only controls implemented by each run kind and requires a real interrupt", () => {
    const waitingPlan = reduceRunEvents({ ...baseRun, kind: "plan", status: "queued" }, [
      event({ type: "run.waiting", seq: 1 }),
    ])
    const approvalPlan = reduceRunEvents({ ...baseRun, kind: "plan", status: "queued" }, [
      event({
        type: "interrupt.requested",
        seq: 1,
        payload: { interruptId: "approval-1" },
      }),
    ])
    const pausedWorkflow = reduceRunEvents({ ...baseRun, status: "running" }, [
      event({ type: "run.paused", seq: 1 }),
    ])
    const pausedAgent = reduceRunEvents({ ...baseRun, kind: "agent-turn", status: "running" }, [
      event({ type: "run.paused", seq: 1 }),
    ])
    const pausedGoal = reduceRunEvents({ ...baseRun, kind: "goal", status: "running" }, [
      event({ type: "run.paused", seq: 1 }),
    ])

    expect(waitingPlan.allowedActions).toEqual(["stop", "open_details"])
    expect(approvalPlan.allowedActions).toEqual(["approve", "deny", "stop", "open_details"])
    expect(pausedWorkflow.allowedActions).toEqual(["stop", "open_details"])
    expect(pausedAgent.allowedActions).toEqual(["resume", "stop", "open_details"])
    expect(pausedGoal.allowedActions).toEqual(["resume", "stop", "open_details"])
  })

  it("replaces removed pending steps when a plan is revised", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({
        type: "plan.created",
        seq: 1,
        payload: { steps: [{ id: "old", title: "Old step" }] },
      }),
      event({
        type: "plan.revised",
        seq: 2,
        payload: { steps: [{ id: "new", title: "New step" }] },
      }),
    ])

    expect(snapshot.pendingSteps.map((step) => step.id)).toEqual(["new"])
  })

  it("correlates tool lifecycle events into one safe activity and deduplicates mirrored steps", () => {
    const agentRun: ExecutionRun = { ...baseRun, kind: "agent-turn" }
    const snapshot = reduceRunEvents(agentRun, [
      event({
        type: "step.added",
        seq: 1,
        payload: { stepId: "tool:call-1", title: "Reading files" },
      }),
      event({
        type: "step.started",
        seq: 2,
        payload: { stepId: "tool:call-1", title: "Reading files" },
      }),
      event({
        type: "tool.started",
        seq: 3,
        payload: {
          toolCallId: "call-1",
          toolName: "Read",
          category: "read",
          target: { kind: "workspace_path", label: "src/index.ts" },
        },
      }),
      event({
        type: "tool.completed",
        seq: 4,
        payload: {
          toolCallId: "call-1",
          toolName: "Read",
          category: "read",
          output: "must not be projected",
        },
      }),
      event({
        type: "step.completed",
        seq: 5,
        payload: { stepId: "tool:call-1", title: "Reading files" },
      }),
    ])

    expect(snapshot.activities).toEqual([
      {
        id: "tool:call-1",
        kind: "tool",
        category: "read",
        status: "completed",
        label: "Read",
        target: { kind: "workspace_path", label: "src/index.ts" },
        startedAt: 1_003,
        endedAt: 1_004,
      },
    ])
    expect(snapshot.activityCount).toBe(1)
    expect(snapshot.omittedActivityCount).toBe(0)
    expect(JSON.stringify(snapshot.activities)).not.toContain("must not be projected")
  })

  it("keeps active activities plus the latest terminal activities and excludes private events", () => {
    const events: RunEvent[] = [
      event({ type: "run.started", seq: 1 }),
      ...Array.from({ length: 14 }, (_, index) =>
        event({
          type: "step.completed",
          seq: index + 2,
          payload: { stepId: `step-${index}`, title: `Step ${index}` },
        })
      ),
      event({
        type: "step.started",
        seq: 16,
        payload: { stepId: "active", title: "Still working" },
      }),
      event({
        type: "artifact.created",
        seq: 17,
        visibility: "private",
        payload: { artifactId: "secret", title: "Private artifact" },
      }),
    ]

    const snapshot = reduceRunEvents(baseRun, events)

    expect(snapshot.activities).toHaveLength(12)
    expect(snapshot.activities?.some((activity) => activity.id === "step:active")).toBe(true)
    expect(snapshot.activities?.some((activity) => activity.label === "Private artifact")).toBe(
      false
    )
    expect(snapshot.activityCount).toBe(16)
    expect(snapshot.omittedActivityCount).toBe(4)
  })

  it.each<ExecutionRunKind>(["agent-turn", "workflow", "plan", "goal", "team", "scheduled"])(
    "projects the shared safe activity model for %s runs",
    (kind) => {
      const snapshot = reduceRunEvents({ ...baseRun, kind }, [
        event({
          type: "step.started",
          seq: 1,
          payload: { stepId: "shared", title: "Shared activity", safeTitle: true },
        }),
      ])

      expect(snapshot.kind).toBe(kind)
      expect(snapshot.activities).toEqual([
        expect.objectContaining({
          id: "step:shared",
          kind: "step",
          status: "running",
          label: "Shared activity",
        }),
      ])
    }
  )

  it("keeps raw commands, queries, URLs, errors, artifact metadata, and PII out of the snapshot", () => {
    const snapshot = reduceRunEvents({ ...baseRun, title: "alice@example.com" }, [
      event({
        type: "step.started",
        seq: 1,
        payload: {
          stepId: "../../etc/passwd",
          title: "curl https://example.com?token=secret",
          summary: "SELECT password FROM users",
          detail: "raw file contents",
        },
      }),
      event({
        type: "interrupt.requested",
        seq: 2,
        payload: {
          interruptId: "approval-1",
          title: "Run `printenv SECRET`",
          reason: "customer@example.com",
        },
      }),
      event({
        type: "artifact.created",
        seq: 3,
        payload: {
          artifactId: "https://example.com/private",
          title: "Customer secrets",
          url: "https://example.com/file?token=secret",
          content: "raw file contents",
        },
      }),
      event({
        type: "run.failed",
        seq: 4,
        payload: { error: "Bearer secret-token-value customer@example.com" },
      }),
    ])

    const serialized = JSON.stringify(snapshot)
    expect(snapshot.title).not.toContain("alice@example.com")
    expect(snapshot.activeSteps[0]?.title).toBe("Step")
    expect(snapshot.activeSteps[0]?.summary).toBeUndefined()
    expect(snapshot.pendingInterrupt).toEqual(
      expect.objectContaining({ title: "Approval required" })
    )
    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^opaque-/), title: "Artifact created" }),
    ])
    expect(snapshot.error).toBe("Run failed")
    for (const secret of [
      "curl",
      "SELECT",
      "https://",
      "../../etc/passwd",
      "raw file contents",
      "customer@example.com",
      "secret-token-value",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })
})

describe("team run allowed actions", () => {
  // Teams only ever offered stop/open_details, which was correct while `team`
  // was registered to the workflow handler — that handler can only cancel, so
  // a pause button would have been a control that always failed. Now that a
  // durable AgentTeam run has a handler that can pause and resume it, the
  // actions have to be offered or the capability stays unreachable.
  it("offers pause while a team run is running", () => {
    const snapshot = reduceRunEvents(
      {
        id: "execution:team:r1",
        kind: "team",
        sourceId: "r1",
        title: "t",
        status: "running",
        currentRevision: 1,
        startedAt: 1,
        updatedAt: 1,
      },
      []
    )
    expect(snapshot.allowedActions).toEqual(
      expect.arrayContaining(["pause", "stop", "open_details"])
    )
  })

  it("offers resume once a team run is paused", () => {
    const snapshot = reduceRunEvents(
      {
        id: "execution:team:r1",
        kind: "team",
        sourceId: "r1",
        title: "t",
        status: "paused",
        currentRevision: 1,
        startedAt: 1,
        updatedAt: 1,
      },
      []
    )
    expect(snapshot.allowedActions).toEqual(
      expect.arrayContaining(["resume", "stop", "open_details"])
    )
  })

  it("still offers only stop for a workflow run", () => {
    const snapshot = reduceRunEvents(
      {
        id: "execution:workflow:r2",
        kind: "workflow",
        sourceId: "r2",
        title: "t",
        status: "running",
        currentRevision: 1,
        startedAt: 1,
        updatedAt: 1,
      },
      []
    )
    expect(snapshot.allowedActions).toEqual(["stop", "open_details"])
  })
})
