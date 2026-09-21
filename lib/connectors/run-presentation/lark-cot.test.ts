import {
  __resetLarkCotSupportCacheForTesting,
  createLarkCotClient,
  createLarkCotProjectionState,
  isLarkCotKnownUnsupported,
  isLarkCotProjectionState,
  isLarkCotUnsupportedError,
  projectLarkCotEvents,
  rememberLarkCotUnsupported,
} from "./lark-cot"
import type { LarkCotEvent, LarkCotProjectionState } from "./lark-cot"
import { resolveActivityI18n } from "@/lib/connectors/activity/i18n"
import type { RunProjectionSnapshot } from "@/types/execution/run"

const i18n = resolveActivityI18n("en")

const base = (over: Partial<RunProjectionSnapshot> = {}): RunProjectionSnapshot => ({
  runId: "run-1",
  kind: "agent-turn",
  title: "Agent run",
  status: "running",
  revision: 1,
  startedAt: 0,
  updatedAt: 1,
  progress: { completed: 0, total: 0, trustworthy: false },
  activeSteps: [],
  recentSteps: [],
  pendingSteps: [],
  pendingStepCount: 0,
  elapsedMs: 0,
  artifacts: [],
  allowedActions: [],
  ...over,
})

const types = (events: LarkCotEvent[]) => events.map((event) => event.event_type)
const content = (event: LarkCotEvent) => JSON.parse(event.content) as Record<string, unknown>

const strictlyIncreasing = (events: LarkCotEvent[]) =>
  events.every((event, index) => index === 0 || event.timestamp > events[index - 1]!.timestamp)

describe("projectLarkCotEvents", () => {
  it("opens with RUN_STARTED, a reasoning segment, and a tool row", () => {
    const snapshot = base({
      activities: [
        {
          id: "step:note",
          kind: "step",
          category: "status",
          status: "running",
          label: "Thinking",
          startedAt: 1,
        },
        {
          id: "tool:read",
          kind: "tool",
          category: "read",
          status: "running",
          label: "Read",
          target: { kind: "workspace_path", label: "src/a.ts" },
          startedAt: 2,
        },
      ],
    })
    const { events, state } = projectLarkCotEvents(
      createLarkCotProjectionState(),
      snapshot,
      i18n,
      1_000
    )
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "TOOL_CALL_START",
    ])
    expect(content(events[0]!)).toEqual({ threadId: "run-1", runId: "run-1" })
    expect(content(events[2]!)).toEqual({ messageId: "reasoning_1", role: "reasoning" })
    expect(content(events[3]!)).toEqual({ messageId: "reasoning_1", delta: "Thinking" })
    expect(content(events[4]!)).toEqual({
      toolCallId: "tool:read",
      toolCallName: "Read",
      title: "Read · src/a.ts",
      icon: "read",
    })
    expect(strictlyIncreasing(events)).toBe(true)
    expect(state.started).toBe(true)
    expect(state.openTools).toEqual(["tool:read"])
  })

  it("emits exactly TOOL_CALL_END when an open tool completes", () => {
    const running = base({
      activities: [
        {
          id: "tool:read",
          kind: "tool",
          category: "read",
          status: "running",
          label: "Read",
          startedAt: 1,
        },
      ],
    })
    const first = projectLarkCotEvents(createLarkCotProjectionState(), running, i18n, 1_000)
    const done = base({
      revision: 2,
      activities: [{ ...running.activities![0]!, status: "completed", endedAt: 5 }],
    })
    const { events, state } = projectLarkCotEvents(first.state, done, i18n, 2_000)
    expect(types(events)).toEqual(["TOOL_CALL_END"])
    expect(content(events[0]!)).toEqual({ toolCallId: "tool:read" })
    expect(state.openTools).toEqual([])
    expect(state.settled).toContain("tool:read")
  })

  it("adds a text TOOL_CALL_RESULT under a failed tool", () => {
    const running = base({
      activities: [
        {
          id: "tool:bash",
          kind: "tool",
          category: "command",
          status: "running",
          label: "Bash",
          startedAt: 1,
        },
      ],
    })
    const first = projectLarkCotEvents(createLarkCotProjectionState(), running, i18n, 1_000)
    const failed = base({
      revision: 2,
      activities: [{ ...running.activities![0]!, status: "failed", endedAt: 5 }],
    })
    const { events } = projectLarkCotEvents(first.state, failed, i18n, 2_000)
    expect(types(events)).toEqual(["TOOL_CALL_END", "TOOL_CALL_RESULT"])
    const result = content(events[1]!)
    expect(result.messageId).toBe("result_tool:bash")
    expect(result.toolCallId).toBe("tool:bash")
    expect(result.role).toBe("tool")
    expect(JSON.parse(result.content as string)).toEqual({ type: "text", text: "Tool failed" })
    // TOOL_CALL_ARGS is invisible on the client and a PII hole — never sent.
    expect(JSON.stringify(events)).not.toContain("TOOL_CALL_ARGS")
  })

  it("extends a growing commentary label with only the suffix delta", () => {
    const snap = (label: string) =>
      base({
        activities: [
          {
            id: "step:note",
            kind: "step",
            category: "status",
            status: "running",
            label,
            startedAt: 1,
          },
        ],
      })
    let state = createLarkCotProjectionState()
    state = projectLarkCotEvents(state, snap("Thinking"), i18n, 1_000).state
    const grown = projectLarkCotEvents(state, snap("Thinking about files"), i18n, 2_000)
    expect(types(grown.events)).toEqual(["REASONING_MESSAGE_CONTENT"])
    expect(content(grown.events[0]!)).toEqual({
      messageId: "reasoning_1",
      delta: " about files",
    })
    // A rewritten (non-prefix) label starts a new line inside the segment.
    const rewritten = projectLarkCotEvents(grown.state, snap("Replanning"), i18n, 3_000)
    expect(content(rewritten.events[0]!)).toEqual({
      messageId: "reasoning_1",
      delta: "\nReplanning",
    })
    // A second commentary source closes the first segment and opens the next.
    const second = projectLarkCotEvents(
      rewritten.state,
      base({
        activities: [
          { ...snap("Replanning").activities![0]! },
          {
            id: "step:next",
            kind: "step",
            category: "status",
            status: "running",
            label: "Next step",
            startedAt: 2,
          },
        ],
      }),
      i18n,
      4_000
    )
    expect(types(second.events)).toEqual([
      "REASONING_MESSAGE_END",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
    ])
    expect(content(second.events[0]!).messageId).toBe("reasoning_1")
    expect(content(second.events[1]!).messageId).toBe("reasoning_2")
  })

  it("ends an open tool whose activity vanished from the window", () => {
    const running = base({
      activities: [
        {
          id: "tool:read",
          kind: "tool",
          category: "read",
          status: "running",
          label: "Read",
          startedAt: 1,
        },
      ],
    })
    const first = projectLarkCotEvents(createLarkCotProjectionState(), running, i18n, 1_000)
    const { events } = projectLarkCotEvents(first.state, base({ revision: 2 }), i18n, 2_000)
    expect(types(events)).toEqual(["TOOL_CALL_END"])
  })

  it("opens and closes a waiting step around a pending interrupt", () => {
    const waiting = base({
      status: "waiting",
      pendingInterrupt: { id: "intr-1", title: "Approval required" },
    })
    const first = projectLarkCotEvents(createLarkCotProjectionState(), waiting, i18n, 1_000)
    expect(types(first.events)).toEqual(["RUN_STARTED", "STEP_STARTED"])
    expect(content(first.events[1]!)).toEqual({
      stepId: "waiting:intr-1",
      stepName: "Waiting for your action",
    })
    const resumed = projectLarkCotEvents(first.state, base({ revision: 2 }), i18n, 2_000)
    expect(types(resumed.events)).toEqual(["STEP_FINISHED"])
    expect(content(resumed.events[0]!)).toEqual({
      stepId: "waiting:intr-1",
      stepName: "Waiting for your action",
    })
    expect(resumed.state.waitingInterruptId).toBeUndefined()
  })

  it("tracks plan milestones from activeSteps that have no activity row", () => {
    // An unrelated activity row keeps the legacy step-fallback off, so the
    // in-progress durable step reaches the milestone path.
    const settledTool = {
      id: "tool:read",
      kind: "tool" as const,
      category: "read" as const,
      status: "completed" as const,
      label: "Read",
      startedAt: 1,
      endedAt: 2,
    }
    const withStep = base({
      activities: [settledTool],
      activeSteps: [{ id: "build", title: "Build the release", status: "in_progress" }],
    })
    const first = projectLarkCotEvents(createLarkCotProjectionState(), withStep, i18n, 1_000)
    expect(types(first.events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "STEP_STARTED",
    ])
    expect(content(first.events[3]!)).toEqual({
      stepId: "step:build",
      stepName: "Build the release",
    })
    const moved = projectLarkCotEvents(
      first.state,
      base({
        revision: 2,
        activities: [settledTool],
        recentSteps: [{ id: "build", title: "Build the release", status: "completed" }],
      }),
      i18n,
      2_000
    )
    expect(types(moved.events)).toEqual(["STEP_FINISHED"])
    expect(moved.state.openSteps).toEqual({})
  })

  it("does not double-emit a durable step that an activity already represents", () => {
    const snapshot = base({
      activeSteps: [{ id: "build", title: "Build", status: "in_progress" }],
      activities: [
        {
          id: "step:build",
          kind: "step",
          category: "status",
          status: "running",
          label: "Build",
          startedAt: 1,
        },
      ],
    })
    const { events } = projectLarkCotEvents(createLarkCotProjectionState(), snapshot, i18n, 1_000)
    expect(types(events).filter((type) => type.startsWith("STEP_"))).toEqual([])
  })

  it("emits START+FINISH for an artifact and ignores approval/lifecycle rows", () => {
    const snapshot = base({
      activities: [
        {
          id: "artifact:1",
          kind: "artifact",
          category: "artifact",
          status: "completed",
          label: "Report",
          startedAt: 1,
          endedAt: 2,
        },
        {
          id: "approval:1",
          kind: "approval",
          category: "approval",
          status: "running",
          label: "Approval",
          startedAt: 3,
        },
        {
          id: "lifecycle:1",
          kind: "lifecycle",
          category: "status",
          status: "completed",
          label: "Run started",
          startedAt: 0,
        },
      ],
    })
    const { events, state } = projectLarkCotEvents(
      createLarkCotProjectionState(),
      snapshot,
      i18n,
      1_000
    )
    expect(types(events)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED"])
    expect(content(events[1]!)).toEqual({ stepId: "artifact:1", stepName: "Report" })
    expect(state.settled).toContain("artifact:1")
  })

  it("closes everything and finishes done on a completed run", () => {
    const running = base({
      activeSteps: [{ id: "build", title: "Build", status: "in_progress" }],
      activities: [
        {
          id: "step:note",
          kind: "step",
          category: "status",
          status: "running",
          label: "Thinking",
          startedAt: 1,
        },
        {
          id: "tool:read",
          kind: "tool",
          category: "read",
          status: "running",
          label: "Read",
          startedAt: 2,
        },
      ],
    })
    const first = projectLarkCotEvents(createLarkCotProjectionState(), running, i18n, 1_000)
    const done = projectLarkCotEvents(
      first.state,
      base({
        revision: 2,
        status: "completed",
        // Terminal snapshots still carry the window: the commentary settled,
        // the tool and the milestone were open when the run ended.
        activities: [
          { ...running.activities![0]!, status: "completed" as const, endedAt: 9 },
          running.activities![1]!,
        ],
        activeSteps: [{ id: "build", title: "Build", status: "in_progress" }],
      }),
      i18n,
      2_000
    )
    expect(types(done.events)).toEqual([
      "REASONING_MESSAGE_END",
      "TOOL_CALL_END",
      "STEP_FINISHED",
      "REASONING_END",
      "RUN_FINISHED",
    ])
    expect(content(done.events.at(-1)!)).toEqual({
      threadId: "run-1",
      runId: "run-1",
      status: "done",
    })
    expect(done.terminalReason).toBe("done")
    expect(done.state.finished).toBe(true)
    expect(strictlyIncreasing(done.events)).toBe(true)
  })

  it("maps a cancelled run to RUN_FINISHED interrupted", () => {
    const { events, terminalReason } = projectLarkCotEvents(
      createLarkCotProjectionState(),
      base({ status: "cancelled" }),
      i18n,
      1_000
    )
    expect(types(events)).toEqual(["RUN_STARTED", "RUN_FINISHED"])
    expect(content(events[1]!)).toMatchObject({ status: "interrupted" })
    expect(terminalReason).toBe("done")
  })

  it("emits RUN_ERROR and requests the error completion on a failed run", () => {
    const { events, terminalReason } = projectLarkCotEvents(
      createLarkCotProjectionState(),
      base({ status: "failed" }),
      i18n,
      1_000
    )
    expect(types(events)).toEqual(["RUN_STARTED", "RUN_ERROR"])
    expect(content(events[1]!)).toEqual({ message: "Task failed", code: "RUN_FAILED" })
    expect(terminalReason).toBe("error")
  })

  it("is a no-op once the run has finished", () => {
    const first = projectLarkCotEvents(
      createLarkCotProjectionState(),
      base({ status: "completed" }),
      i18n,
      1_000
    )
    const again = projectLarkCotEvents(
      first.state,
      base({
        revision: 2,
        status: "completed",
        activities: [
          {
            id: "tool:new",
            kind: "tool",
            category: "command",
            status: "running",
            label: "Bash",
            startedAt: 1,
          },
        ],
      }),
      i18n,
      2_000
    )
    expect(again.events).toEqual([])
    expect(again.state).toBe(first.state)
  })

  it("is deterministic: same state + snapshot produces identical events", () => {
    const running = base({
      activities: [
        {
          id: "tool:read",
          kind: "tool",
          category: "read",
          status: "running",
          label: "Read",
          startedAt: 1,
        },
      ],
    })
    const state = projectLarkCotEvents(createLarkCotProjectionState(), running, i18n, 500).state
    const next = base({
      revision: 2,
      activities: [{ ...running.activities![0]!, status: "completed" }],
    })
    const a = projectLarkCotEvents(state, next, i18n, 1_000)
    const b = projectLarkCotEvents(state, next, i18n, 1_000)
    expect(a).toEqual(b)
    // And a persisted (JSON round-tripped) state diffs identically.
    const restored = JSON.parse(JSON.stringify(state)) as LarkCotProjectionState
    expect(projectLarkCotEvents(restored, next, i18n, 1_000)).toEqual(a)
  })

  it("keeps every event content within the 4096-char budget", () => {
    const snapshot = base({
      activities: [
        {
          id: "step:note",
          kind: "step",
          category: "status",
          status: "running",
          label: "x".repeat(10_000),
          startedAt: 1,
        },
      ],
      activeSteps: [{ id: "build", title: "y".repeat(9_000), status: "in_progress" }],
    })
    const { events } = projectLarkCotEvents(createLarkCotProjectionState(), snapshot, i18n, 1_000)
    for (const event of events) {
      expect(event.content.length).toBeLessThanOrEqual(4_096)
    }
  })
})

describe("isLarkCotProjectionState", () => {
  it("accepts the fresh state and rejects malformed persisted shapes", () => {
    expect(isLarkCotProjectionState(createLarkCotProjectionState())).toBe(true)
    expect(isLarkCotProjectionState({ ...createLarkCotProjectionState(), version: 2 })).toBe(false)
    expect(isLarkCotProjectionState({ ...createLarkCotProjectionState(), openTools: "tool" })).toBe(
      false
    )
    expect(isLarkCotProjectionState({ ...createLarkCotProjectionState(), settled: [1] })).toBe(
      false
    )
    expect(isLarkCotProjectionState(undefined)).toBe(false)
    expect(isLarkCotProjectionState("active")).toBe(false)
    expect(isLarkCotProjectionState(null)).toBe(false)
  })
})

describe("createLarkCotClient", () => {
  const handle = { cotId: "cot-1", messageId: "om-cot-1" }
  const event = (index: number): LarkCotEvent => ({
    event_type: "STEP_STARTED",
    content: JSON.stringify({ stepId: `s${index}`, stepName: "x" }),
    timestamp: index + 1,
  })

  it("creates a COT against the chat with an optional origin anchor", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const client = createLarkCotClient(async (method, path, body) => {
      calls.push({ method, path, body })
      return { data: { cot_id: "cot-1", message_id: "om-cot-1" } }
    })
    await expect(client.create({ chatId: "chat-1", originMessageId: "om-1" })).resolves.toEqual(
      handle
    )
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/im/v1/message_cot?receive_id_type=chat_id",
        body: { receive_id: "chat-1", origin_message_id: "om-1" },
      },
    ])
    calls.length = 0
    await client.create({ chatId: "chat-2" })
    expect(calls[0]!.body).toEqual({ receive_id: "chat-2" })
  })

  it("rejects a create response missing the cot handle", async () => {
    const client = createLarkCotClient(async () => ({ data: {} }))
    await expect(client.create({ chatId: "chat-1" })).rejects.toThrow("cot_id")
  })

  it("writes events in chunks of 50 pacing requests at least 65ms apart", async () => {
    const puts: Array<unknown> = []
    const sleeps: number[] = []
    let clock = 0
    const client = createLarkCotClient(
      async (_method, _path, body) => {
        puts.push(body)
        return { data: {} }
      },
      { sleep: async (ms) => void sleeps.push(ms), now: () => clock }
    )
    const events = Array.from({ length: 120 }, (_, index) => event(index))
    await client.write(handle, events)
    expect(puts).toHaveLength(3)
    expect((puts[0] as { events: unknown[] }).events).toHaveLength(50)
    expect((puts[1] as { events: unknown[] }).events).toHaveLength(50)
    expect((puts[2] as { events: unknown[] }).events).toHaveLength(20)
    // now() never advances → each request after the first waits the full 65ms.
    expect(sleeps).toEqual([65, 65])
    expect((puts[0] as { cot_id: string }).cot_id).toBe("cot-1")

    // A later write still respects the spacing since the last request.
    clock = 30
    puts.length = 0
    await client.write(handle, [event(0)])
    expect(sleeps.at(-1)).toBe(35)
    expect(puts).toHaveLength(1)
  })

  it("retries a transient write failure once after ~300ms", async () => {
    const sleeps: number[] = []
    let attempts = 0
    const client = createLarkCotClient(
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error("connection reset")
        return { data: {} }
      },
      { sleep: async (ms) => void sleeps.push(ms), now: () => 1_000 }
    )
    await expect(client.write(handle, [event(0)])).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(sleeps).toEqual([300])
  })

  it("never retries a 230001 param-invalid write", async () => {
    let attempts = 0
    const client = createLarkCotClient(
      async () => {
        attempts += 1
        throw { code: 230001 }
      },
      { sleep: async () => undefined, now: () => 1_000 }
    )
    await expect(client.write(handle, [event(0)])).rejects.toEqual({ code: 230001 })
    expect(attempts).toBe(1)
  })

  it("completes a COT with the encoded handle and reason", async () => {
    const calls: Array<{ method: string; path: string }> = []
    const client = createLarkCotClient(async (method, path) => {
      calls.push({ method, path })
      return { data: {} }
    })
    await client.complete({ cotId: "cot 1", messageId: "om 1" }, "error")
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/im/v1/message_cot/complete/cot%201?message_id=om%201&reason=error",
      },
    ])
  })
})

describe("isLarkCotUnsupportedError", () => {
  it("matches HTTP 404, the param/scope code family, and permission messages", () => {
    expect(isLarkCotUnsupportedError({ status: 404 })).toBe(true)
    expect(isLarkCotUnsupportedError({ code: 230001 })).toBe(true)
    expect(isLarkCotUnsupportedError({ code: 99991672 })).toBe(true)
    expect(isLarkCotUnsupportedError({ code: 99991661 })).toBe(true)
    expect(isLarkCotUnsupportedError({ code: 99991663 })).toBe(true)
    expect(isLarkCotUnsupportedError(new Error("API not found"))).toBe(true)
    expect(isLarkCotUnsupportedError(new Error("no permission to call"))).toBe(true)
    expect(isLarkCotUnsupportedError(new Error("missing im:message_cot scope"))).toBe(true)
  })

  it("treats transient failures as supported", () => {
    expect(isLarkCotUnsupportedError({ code: 99991400 })).toBe(false)
    expect(isLarkCotUnsupportedError({ status: 500 })).toBe(false)
    expect(isLarkCotUnsupportedError(new Error("connection reset"))).toBe(false)
    expect(isLarkCotUnsupportedError(undefined)).toBe(false)
    expect(isLarkCotUnsupportedError(null)).toBe(false)
    expect(isLarkCotUnsupportedError("404")).toBe(false)
  })
})

describe("unsupported-probe cache", () => {
  beforeEach(() => __resetLarkCotSupportCacheForTesting())
  afterEach(() => __resetLarkCotSupportCacheForTesting())

  it("remembers an adapter for six hours then re-probes", () => {
    expect(isLarkCotKnownUnsupported("lark-1", 1_000)).toBe(false)
    rememberLarkCotUnsupported("lark-1", "unsupported", 1_000)
    expect(isLarkCotKnownUnsupported("lark-1", 1_000)).toBe(true)
    expect(isLarkCotKnownUnsupported("lark-1", 1_000 + 6 * 60 * 60 * 1_000 - 1)).toBe(true)
    expect(isLarkCotKnownUnsupported("lark-1", 1_000 + 6 * 60 * 60 * 1_000)).toBe(false)
    expect(isLarkCotKnownUnsupported("lark-2", 1_000)).toBe(false)
  })
})
