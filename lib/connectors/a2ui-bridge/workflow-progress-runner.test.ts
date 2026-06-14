import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { EnqueueInput } from "@/lib/db/outbound-jobs"
import type { VisualWorkflow, WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import {
  __resetWorkflowProgressRunnerForTesting,
  startWorkflowProgressRunner,
} from "./workflow-progress-runner"
import { createFanoutSubscription, listForWorkflow } from "@/lib/db/workflow-fanout-subscriptions"

// The runner fires a proactive completion notification (workflow⇄IM parity) via
// a dynamic import of conversation-notify in emitFinal. Mock it so we can assert
// the one-shot call without standing up the Notification Center pipe.
const mockNotifyConversationOverIM = jest.fn(async () => "rec_x")
jest.mock("@/lib/notifications/conversation-notify", () => ({
  __esModule: true,
  notifyConversationOverIM: (...args: unknown[]) => mockNotifyConversationOverIM(...(args as [])),
}))

function makeWorkflowSnapshot(): VisualWorkflow {
  return {
    id: "wf1",
    schemaVersion: 1,
    name: "Demo",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "step_search",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Search", params: {} },
      },
      {
        id: "step_summarize",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Summarize", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 0,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

async function putRun(partial: Partial<WorkflowRunRow>): Promise<WorkflowRunRow> {
  const row: WorkflowRunRow = {
    id: "run1",
    workflowId: "wf1",
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1_000_000,
    workflowSnapshot: makeWorkflowSnapshot(),
    triggeredBy: {
      source: "im",
      adapterId: "wecom:a",
      conversationKey: "wecom:wecom:a:room1",
      sessionId: "s1",
    },
    ...partial,
  }
  await getDb().workflowRuns.put(row)
  return row
}

async function putEvent(ev: Partial<WorkflowRunEventRow> & { id: string }): Promise<void> {
  await getDb().workflowRunEvents.put({
    runId: "run1",
    ts: 1_000_000,
    type: "step_started",
    ...ev,
  })
}

interface CapturedJob {
  adapterId: string
  conversationKey: string
  source: string
  idempotencyKey?: string
  segments: unknown[]
  sourceWorkflow?: { workflowId: string; runId: string; nodeId: string }
  editTargetMessageId?: string
}

interface MockEnqueueOpts {
  /** Returned as the entry job's id so the runner can correlate later. */
  jobIdSequence?: string[]
  /**
   * If provided and an `entry-` job has been observed, the next reads of
   * that job from Dexie return a row with this `platformMessageId` set.
   * The mock writes the row directly so the runner's
   * `getDb().outboundQueue.get(entryJobId)` returns it.
   */
  entryPlatformMessageId?: string
}

function makeMockEnqueue(opts: MockEnqueueOpts = {}): {
  enqueue: (input: EnqueueInput) => Promise<import("@/lib/db/connector-types").OutboundJobRow>
  jobs: CapturedJob[]
} {
  const jobs: CapturedJob[] = []
  const ids = opts.jobIdSequence ?? []
  let i = 0
  const enqueue = async (
    input: EnqueueInput
  ): Promise<import("@/lib/db/connector-types").OutboundJobRow> => {
    const id = ids[i] ?? `oqj_${i}`
    i++
    jobs.push({
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      source: input.source,
      idempotencyKey: input.request.metadata.idempotencyKey,
      segments: input.request.segments,
      sourceWorkflow: input.sourceWorkflow,
      editTargetMessageId: input.request.editTargetMessageId,
    })
    const stubRow: import("@/lib/db/connector-types").OutboundJobRow = {
      id,
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      request: input.request,
      status: "sent",
      attempts: 1,
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
      idempotencyKey: input.request.metadata.idempotencyKey,
      source: input.source,
      ...(input.source === "workflow" && input.sourceWorkflow
        ? { sourceWorkflow: input.sourceWorkflow }
        : {}),
      ...(opts.entryPlatformMessageId &&
      input.request.metadata.idempotencyKey?.startsWith("wf-status-entry:")
        ? { platformMessageId: opts.entryPlatformMessageId }
        : {}),
    }
    // For cumulative-mode tests, the runner reads back the entry job
    // row from Dexie to find its platformMessageId. Write the stub row
    // so that lookup resolves once we've returned.
    if (
      opts.entryPlatformMessageId &&
      input.request.metadata.idempotencyKey?.startsWith("wf-status-entry:")
    ) {
      await getDb().outboundQueue.put(stubRow)
    }
    return stubRow
  }
  return { enqueue, jobs }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  describe: () => string = () => "predicate"
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out: ${describe()}`)
    }
    await new Promise((r) => setTimeout(r, 30))
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetWorkflowProgressRunnerForTesting()
  mockNotifyConversationOverIM.mockClear()
})

afterEach(() => {
  __resetWorkflowProgressRunnerForTesting()
})

describe("workflow-progress-runner", () => {
  it("ignores runs that are not IM-triggered", async () => {
    await putRun({ triggeredBy: undefined })
    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })
    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    // Give the live-query a beat to settle.
    await new Promise((r) => setTimeout(r, 200))
    expect(jobs).toHaveLength(0)
    stop()
  })

  it("fans step events out to enqueueOutbound with the right metadata", async () => {
    const run = await putRun({})
    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })

    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await putEvent({
      id: "ev2",
      stepId: "step_search",
      type: "step_completed",
      ts: 1_001_300,
    })

    await waitFor(() => jobs.length >= 2)

    const [first, second] = jobs
    expect(first.adapterId).toBe("wecom:a")
    expect(first.conversationKey).toBe(run.triggeredBy!.conversationKey)
    expect(first.source).toBe("workflow")
    expect(first.sourceWorkflow).toEqual({
      workflowId: "wf1",
      runId: "run1",
      nodeId: "step_search",
    })
    // The label from the snapshot is used in the markdown line.
    expect(JSON.stringify(first.segments)).toContain("Search")
    expect(JSON.stringify(first.segments)).toContain("开始")
    expect(JSON.stringify(second.segments)).toContain("完成")
    stop()
  })

  it("emits a single final surface on terminal status", async () => {
    await putRun({})
    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })

    // Simulate a step completing then run terminating.
    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await putEvent({
      id: "ev2",
      stepId: "step_search",
      type: "step_completed",
      ts: 1_000_900,
    })
    await waitFor(() => jobs.length >= 2)

    await putRun({
      status: "succeeded",
      output: { summary: "done" },
      completedAt: 1_002_000,
    })

    await waitFor(() => jobs.some((j) => j.idempotencyKey?.startsWith("final:run1:")))
    const final = jobs.find((j) => j.idempotencyKey?.startsWith("final:run1:"))!
    const a2uiSeg = final.segments.find(
      (s): s is { type: string; plainTextMirror: string } =>
        Boolean(s) && (s as { type?: unknown }).type === "a2ui"
    )
    expect(a2uiSeg).toBeDefined()
    expect(a2uiSeg!.plainTextMirror).toContain("Succeeded")
    stop()
  })

  it("fires a proactive completion notification on terminal success", async () => {
    await putRun({})
    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })
    await putRun({ status: "succeeded", output: { summary: "done" }, completedAt: 1_002_000 })
    await waitFor(() => jobs.some((j) => j.idempotencyKey?.startsWith("final:run1:")))
    await waitFor(() => mockNotifyConversationOverIM.mock.calls.length >= 1)
    const arg = mockNotifyConversationOverIM.mock.calls[0][0] as unknown as {
      conversationKey: string
      level: string
      dedupeKey: string
    }
    expect(arg.conversationKey).toBe("wecom:wecom:a:room1")
    expect(arg.level).toBe("info")
    expect(arg.dedupeKey).toBe("wf-complete:run1")
    stop()
  })

  it("uses error level for a failed terminal status", async () => {
    await putRun({})
    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })
    await putRun({ status: "failed", error: { message: "boom" }, completedAt: 1_002_000 })
    await waitFor(() => jobs.some((j) => j.idempotencyKey?.startsWith("final:run1:")))
    await waitFor(() => mockNotifyConversationOverIM.mock.calls.length >= 1)
    const arg = mockNotifyConversationOverIM.mock.calls[0][0] as unknown as { level: string }
    expect(arg.level).toBe("error")
    stop()
  })

  it("does not notify for a non-IM run", async () => {
    await putRun({ triggeredBy: undefined })
    const { enqueue } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })
    await putRun({ triggeredBy: undefined, status: "succeeded", completedAt: 1_002_000 })
    await new Promise((r) => setTimeout(r, 200))
    expect(mockNotifyConversationOverIM).not.toHaveBeenCalled()
    stop()
  })

  it("re-attaches subscriptions on cold-start for non-terminal runs", async () => {
    // Seed an active run + a pre-existing event BEFORE the runner mounts.
    await putRun({})
    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })
    await waitFor(() => jobs.length >= 1)
    expect(jobs[0].sourceWorkflow?.runId).toBe("run1")
    stop()
  })

  it("does not double-emit a single event when liveQuery refires", async () => {
    await putRun({})
    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({ enqueue })
    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await waitFor(() => jobs.length >= 1)
    // Force a re-fire by inserting an unrelated row that triggers
    // the same query observable.
    await putEvent({
      id: "ev2",
      stepId: "step_search",
      type: "step_completed",
      ts: 1_000_200,
    })
    await waitFor(() => jobs.length >= 2)
    expect(
      jobs.filter(
        (j) => j.idempotencyKey?.startsWith("progress:run1:") && j.idempotencyKey?.endsWith(":ev1")
      )
    ).toHaveLength(1)
    stop()
  })

  it("is idempotent — second start is a no-op until stop", async () => {
    const { enqueue } = makeMockEnqueue()
    const stop1 = startWorkflowProgressRunner({ enqueue })
    const stop2 = startWorkflowProgressRunner({ enqueue })
    expect(stop1).toBe(stop2)
    stop1()
  })
})

describe("workflow-progress-runner — cumulative mode (adapter supports edit)", () => {
  it("sends one cumulative card on first event then edits on subsequent events", async () => {
    await putRun({})
    const { enqueue, jobs } = makeMockEnqueue({
      jobIdSequence: ["oqj_entry", "oqj_edit1", "oqj_edit2"],
      entryPlatformMessageId: "lark-msg-id-9",
    })
    const stop = startWorkflowProgressRunner({
      enqueue,
      adapterSupportsEdit: () => true,
    })

    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await waitFor(() => jobs.length >= 1)
    const entry = jobs[0]
    expect(entry.idempotencyKey?.startsWith("wf-status-entry:run1:")).toBe(true)
    expect(entry.editTargetMessageId).toBeUndefined()

    await putEvent({
      id: "ev2",
      stepId: "step_search",
      type: "step_completed",
      ts: 1_001_300,
    })
    await waitFor(() => jobs.length >= 2)
    const update = jobs[1]
    expect(update.editTargetMessageId).toBe("lark-msg-id-9")
    expect(update.idempotencyKey).toMatch(/^wf-status:run1:/)
    // Cumulative card mirror carries BOTH steps' state because we
    // folded them in order.
    const seg = update.segments.find(
      (s): s is { type: string; plainTextMirror: string } =>
        Boolean(s) && (s as { type?: unknown }).type === "a2ui"
    )!
    expect(seg.plainTextMirror).toContain("Search")
    expect(seg.plainTextMirror).toContain("✓ Search")
    stop()
  })

  it("flips status + appends terminal body on run completion", async () => {
    await putRun({})
    const { enqueue, jobs } = makeMockEnqueue({
      jobIdSequence: ["oqj_entry", "oqj_final"],
      entryPlatformMessageId: "lark-msg-id-final",
    })
    const stop = startWorkflowProgressRunner({
      enqueue,
      adapterSupportsEdit: () => true,
    })

    // Both step events arrive before any wait — cumulative mode folds
    // both into a single entry-card dispatch. That's the contract: one
    // status card, edited later.
    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await putEvent({
      id: "ev2",
      stepId: "step_search",
      type: "step_completed",
      ts: 1_001_000,
    })
    await waitFor(() => jobs.length >= 1)

    await putRun({
      status: "succeeded",
      output: { summary: "done" },
      completedAt: 1_002_000,
    })
    await waitFor(
      () => jobs.length >= 2,
      3000,
      () => `jobs=${jobs.length}: ${jobs.map((j) => j.idempotencyKey).join(",")}`
    )
    const finalJob = jobs[jobs.length - 1]
    expect(finalJob.editTargetMessageId).toBe("lark-msg-id-final")
    const seg = finalJob.segments.find(
      (s): s is { type: string; plainTextMirror: string } =>
        Boolean(s) && (s as { type?: unknown }).type === "a2ui"
    )!
    expect(seg.plainTextMirror).toContain("Succeeded")
    expect(seg.plainTextMirror).toContain("summary")
    expect(seg.plainTextMirror).toContain("cognia://workflow-run/")
    stop()
  })

  it("falls back to a fresh send when the entry job has no platformMessageId yet", async () => {
    await putRun({})
    // No entryPlatformMessageId — the runner won't find a messageId on
    // the entry job, so subsequent flushes dispatch WITHOUT
    // editTargetMessageId (still a fresh send).
    const { enqueue, jobs } = makeMockEnqueue({
      jobIdSequence: ["oqj_entry", "oqj_extra"],
    })
    const stop = startWorkflowProgressRunner({
      enqueue,
      adapterSupportsEdit: () => true,
    })

    // Separate awaits so each event lands in its own emit batch — that
    // exercises the "subsequent flush" branch even when the entry job's
    // platformMessageId isn't yet on the Dexie row.
    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await waitFor(() => jobs.length >= 1)
    await putEvent({
      id: "ev2",
      stepId: "step_search",
      type: "step_completed",
      ts: 1_001_000,
    })
    await waitFor(
      () => jobs.length >= 2,
      3000,
      () => `jobs=${jobs.length}: ${jobs.map((j) => j.idempotencyKey).join(",")}`
    )
    expect(jobs[1].editTargetMessageId).toBeUndefined()
    stop()
  })
})

describe("workflow-progress-runner — fan-out mirroring (Phase 7)", () => {
  it("dispatches to the originator + every live subscription", async () => {
    await putRun({})
    await createFanoutSubscription({
      workflowId: "wf1",
      adapterId: "lark:ops",
      conversationKey: "lark:lark:ops:oc_ops",
      createdBy: "settings-ui",
    })
    await createFanoutSubscription({
      workflowId: "wf1",
      adapterId: "wecom:audit",
      conversationKey: "wecom:wecom:audit:audit_room",
      createdBy: "settings-ui",
    })

    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({
      enqueue,
      adapterSupportsEdit: () => false, // all append-mode for simplicity
    })

    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await waitFor(() => jobs.length >= 3)

    const channels = new Set(jobs.map((j) => j.adapterId))
    expect(channels.has("wecom:a")).toBe(true) // originator
    expect(channels.has("lark:ops")).toBe(true) // subscription #1
    expect(channels.has("wecom:audit")).toBe(true) // subscription #2
    stop()
  })

  it("dedupes a subscription that overlaps the originator channel", async () => {
    await putRun({})
    // Originator is (wecom:a, wecom:wecom:a:room1). Subscribe THE SAME
    // channel — the watcher must merge into one dispatch.
    await createFanoutSubscription({
      workflowId: "wf1",
      adapterId: "wecom:a",
      conversationKey: "wecom:wecom:a:room1",
      createdBy: "settings-ui",
    })

    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({
      enqueue,
      adapterSupportsEdit: () => false,
    })

    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await waitFor(() => jobs.length >= 1)
    expect(jobs.filter((j) => j.adapterId === "wecom:a")).toHaveLength(1)
    stop()
  })

  it("ignores disabled subscriptions", async () => {
    await putRun({})
    await createFanoutSubscription({
      workflowId: "wf1",
      adapterId: "lark:ops",
      conversationKey: "lark:lark:ops:oc_ops",
      enabled: false,
      createdBy: "settings-ui",
    })

    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({
      enqueue,
      adapterSupportsEdit: () => false,
    })

    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await waitFor(() => jobs.length >= 1)
    // Only the originator's dispatch lands; the disabled mirror sub is
    // filtered out at createWatcher time.
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("wecom:a")
    stop()
  })

  it("supports mixed modes per channel (originator cumulative, mirror append)", async () => {
    await putRun({})
    await createFanoutSubscription({
      workflowId: "wf1",
      adapterId: "wecom:mirror",
      conversationKey: "wecom:wecom:mirror:c1",
      createdBy: "settings-ui",
    })

    const { enqueue, jobs } = makeMockEnqueue({
      // The first cumulative entry-card lands as job 0. Wire its
      // platformMessageId via the mock's row writer.
      entryPlatformMessageId: "lark-msg-id-x",
    })
    const stop = startWorkflowProgressRunner({
      enqueue,
      // Only the originator's adapter supports edit; the mirror stays append.
      adapterSupportsEdit: (adapterId) => adapterId === "wecom:a",
    })

    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await waitFor(() => jobs.length >= 2)

    const originator = jobs.find((j) => j.adapterId === "wecom:a")!
    const mirror = jobs.find((j) => j.adapterId === "wecom:mirror")!
    // Originator is cumulative — entry idempotency key carries the
    // wf-status-entry prefix.
    expect(originator.idempotencyKey?.startsWith("wf-status-entry:run1:")).toBe(true)
    // Mirror is append — gets a per-event progress key.
    expect(mirror.idempotencyKey?.startsWith("progress:run1:")).toBe(true)
    expect(mirror.idempotencyKey?.endsWith(":ev1")).toBe(true)
    stop()
  })
})

describe("workflow-fanout-subscriptions integration (sanity)", () => {
  it("seed is observable via listForWorkflow once persisted", async () => {
    await createFanoutSubscription({
      workflowId: "wf_x",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    const live = await listForWorkflow("wf_x")
    expect(live.map((r) => r.adapterId)).toEqual(["lark:a"])
  })
})

describe("workflow-progress-runner — concurrency safety", () => {
  it("does not create duplicate watchers when reconcile races (slow async subs read)", async () => {
    await putRun({})
    // Slow the fan-out lookup so two reconciles collide. listSubsCalls
    // counts how many times createWatcher actually invoked listSubs —
    // we expect ONE (the second reconcile should await the first
    // promise instead of starting a parallel read).
    let listSubsCalls = 0
    const slowList = async (workflowId: string) => {
      listSubsCalls++
      await new Promise((r) => setTimeout(r, 50))
      return listForWorkflow(workflowId)
    }

    const { enqueue, jobs } = makeMockEnqueue()
    const stop = startWorkflowProgressRunner({
      enqueue,
      adapterSupportsEdit: () => false,
      listSubscriptions: slowList,
    })

    // Two consecutive events provoke two runs-liveQuery refires; both
    // observe the same active run while the first reconcile is still
    // awaiting slowList.
    await putEvent({ id: "ev1", stepId: "step_search", type: "step_started", ts: 1_000_100 })
    await putEvent({ id: "ev2", stepId: "step_search", type: "step_completed", ts: 1_000_200 })
    await waitFor(() => jobs.length >= 2, 3000)

    expect(listSubsCalls).toBe(1)
    stop()
  })
})
