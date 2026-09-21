/** @jest-environment jsdom */

import type { RunEvent, RunSnapshot } from "@cognia/router-fusion"

import {
  applyCompanionEventsPage,
  cancelCompanionFusionRun,
  companionRunAnswerOf,
  companionRunSummaryOf,
  emptyCompanionRunFollow,
  enqueueCompanionFusionRun,
  followCompanionFusionRun,
  readBackCompanionFusionRun,
  type CompanionRunFollow,
  type CompanionRunIo,
} from "./companion-run-client"

const RUN = "8b1f7a2e-0000-4000-8000-000000000001"

function event(seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent {
  return {
    schema_version: "1.0.0",
    run_id: RUN,
    seq,
    event_type: type as RunEvent["event_type"],
    timestamp: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    payload,
  }
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    schema_version: "1.0.0",
    run_id: RUN,
    session_id: "8b1f7a2e-0000-4000-8000-00000000000a",
    session_version: 3,
    status: "running",
    phase: "cascade",
    version: 4,
    created_at: new Date(1_800_000_000_000).toISOString(),
    deadline_at: new Date(1_800_003_600_000).toISOString(),
    decision: null,
    result: null,
    billing: {
      budget_cap_microusd: 1_200_000,
      spent_microusd: 4_000,
      active_step_reservations_microusd: 0,
      tenant_hold_microusd: 0,
      status: "actual",
      overspend_microusd: 0,
      model_calls: 2,
    },
    error: null,
    pending_approval_id: null,
    trace_id: RUN,
    ...overrides,
  } as RunSnapshot
}

function fakeIo(answers: Record<string, Array<unknown | Error>>): {
  io: Partial<CompanionRunIo>
  calls: Array<{ command: string; args: Record<string, unknown>; options?: unknown }>
} {
  const calls: Array<{ command: string; args: Record<string, unknown>; options?: unknown }> = []
  const io: Partial<CompanionRunIo> = {
    call: (async (command: string, args: Record<string, unknown>, options?: unknown) => {
      calls.push({ command, args, ...(options ? { options } : {}) })
      const queue = answers[command] ?? []
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next
    }) as CompanionRunIo["call"],
    sleep: async () => undefined,
  }
  return { io, calls }
}

describe("enqueueCompanionFusionRun", () => {
  it("queues execution_run_create with one key for the row and the Run API", async () => {
    const enqueue = jest.fn(async (input: { payload: Record<string, unknown> }) => ({
      id: "row-1",
      createdAt: 42,
      ...input,
    }))
    const pending = await enqueueCompanionFusionRun(
      { sessionId: "s1", text: "summarise", mode: "cascade", label: "Cascade run" },
      { enqueue: enqueue as never, newId: () => "uuid-1" }
    )
    expect(enqueue).toHaveBeenCalledWith({
      command: "execution_run_create",
      payload: {
        mode: "cascade",
        text: "summarise",
        sessionId: "s1",
        idempotencyKey: "companion-run:uuid-1",
      },
      idempotencyKey: "companion-run:uuid-1",
      label: "Cascade run",
    })
    expect(pending).toMatchObject({
      rowId: "row-1",
      idempotencyKey: "companion-run:uuid-1",
      mode: "cascade",
      sessionId: "s1",
      createdAt: 42,
    })
  })
})

describe("readBackCompanionFusionRun", () => {
  const pending = {
    idempotencyKey: "companion-run:k",
    payload: { mode: "panel" as const, text: "hi", idempotencyKey: "companion-run:k" },
  }

  it("replays the delivered request under its own key to learn the run", async () => {
    const accepted = { run_id: RUN, status: "queued" }
    const { io, calls } = fakeIo({
      execution_run_create: [{ ok: true, value: { accepted, replayed: true } }],
    })
    await expect(readBackCompanionFusionRun(pending, io)).resolves.toEqual({
      ok: true,
      value: accepted,
    })
    expect(calls).toEqual([
      {
        command: "execution_run_create",
        args: pending.payload,
        options: { idempotencyKey: "companion-run:k" },
      },
    ])
  })

  it("reports the host's refusal and a transport failure in the same words", async () => {
    const refused = fakeIo({
      execution_run_create: [
        { ok: false, error: { status: 403, code: "ROUTER_FUSION_DISABLED", message: "off" } },
      ],
    })
    await expect(readBackCompanionFusionRun(pending, refused.io)).resolves.toEqual({
      ok: false,
      error: { status: 403, code: "ROUTER_FUSION_DISABLED", message: "off" },
    })
    const lost = fakeIo({
      execution_run_create: [Object.assign(new Error("socket closed"), { code: "offline" })],
    })
    await expect(readBackCompanionFusionRun(pending, lost.io)).resolves.toEqual({
      ok: false,
      error: { code: "offline", message: "socket closed" },
    })
  })
})

describe("applyCompanionEventsPage", () => {
  it("[ACC:REC-07] keeps only the contiguous run of events: duplicates dropped, a gap never stepped over", () => {
    let view = emptyCompanionRunFollow(RUN)
    view = applyCompanionEventsPage(view, {
      events: [event(1, "run.queued"), event(2, "route.selected")],
      lastSeq: 5,
      terminal: false,
    })
    expect(view.lastSeq).toBe(2)
    // A retried page overlapping what is held, then a gap after seq 3.
    view = applyCompanionEventsPage(view, {
      events: [event(2, "route.selected"), event(3, "phase.changed"), event(5, "run.completed")],
      lastSeq: 5,
      terminal: true,
    })
    expect(view.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(view.lastSeq).toBe(3)
    // Terminal only once everything up to the host's last seq is held.
    expect(view.terminal).toBe(false)
    view = applyCompanionEventsPage(view, {
      events: [event(4, "answer.completed"), event(5, "run.completed")],
      lastSeq: 5,
      terminal: true,
    })
    expect(view.lastSeq).toBe(5)
    expect(view.terminal).toBe(true)
  })

  it("ignores events of another run", () => {
    const view = applyCompanionEventsPage(emptyCompanionRunFollow(RUN), {
      events: [{ ...event(1, "run.queued"), run_id: "other" }],
      lastSeq: 1,
      terminal: false,
    })
    expect(view.events).toEqual([])
  })
})

describe("followCompanionFusionRun", () => {
  it("[ACC:REC-07] loses a poll, reads again from the same seq, and reaches the terminal state gap-free", async () => {
    const done = snapshot({
      status: "succeeded",
      result: { answer: "the verified answer", quality_status: "accepted" } as never,
    })
    const { io, calls } = fakeIo({
      execution_run_get: [
        { ok: true, value: { snapshot: snapshot(), resultExpired: false } },
        { ok: true, value: { snapshot: done, resultExpired: false } },
      ],
      execution_run_events: [
        {
          ok: true,
          value: {
            events: [event(1, "run.queued"), event(2, "route.selected")],
            lastSeq: 2,
            terminal: false,
          },
        },
        new Error("network down"),
        {
          ok: true,
          value: {
            events: [
              event(3, "answer.completed", { quality_status: "accepted" }),
              event(4, "run.completed"),
            ],
            lastSeq: 4,
            terminal: true,
          },
        },
      ],
    })
    const updates: CompanionRunFollow[] = []
    const view = await followCompanionFusionRun(RUN, { io, onUpdate: (next) => updates.push(next) })
    const pages = calls.filter((call) => call.command === "execution_run_events")
    expect(pages.map((call) => call.args.afterSeq)).toEqual([0, 2, 2])
    expect(updates.some((update) => update.error?.code === "TRANSPORT_FAILED")).toBe(true)
    expect(view.events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(view.terminal).toBe(true)
    expect(view.error).toBeNull()
    expect(companionRunAnswerOf(view)).toBe("the verified answer")
  })

  it("reads the snapshot instead of skipping when the host no longer holds the history", async () => {
    const { io, calls } = fakeIo({
      execution_run_get: [
        { ok: true, value: { snapshot: snapshot(), resultExpired: false } },
        { ok: true, value: { snapshot: snapshot({ status: "failed" }), resultExpired: false } },
      ],
      execution_run_events: [
        { ok: false, error: { status: 410, code: "EVENT_HISTORY_EXPIRED", message: "gone" } },
      ],
    })
    const view = await followCompanionFusionRun(RUN, { io, onUpdate: () => undefined })
    expect(view.historyExpired).toBe(true)
    expect(view.terminal).toBe(true)
    expect(view.snapshot?.status).toBe("failed")
    // Nothing after the gap was ever asked for.
    expect(calls.filter((call) => call.command === "execution_run_events")).toHaveLength(1)
  })

  it("stops on a refusal no retry can change", async () => {
    const { io } = fakeIo({
      execution_run_get: [
        { ok: false, error: { status: 403, code: "ROUTER_FUSION_DISABLED", message: "off" } },
      ],
    })
    const view = await followCompanionFusionRun(RUN, { io, onUpdate: () => undefined })
    expect(view).toMatchObject({ terminal: true, error: { code: "ROUTER_FUSION_DISABLED" } })
  })

  it("stops polling when the view goes away", async () => {
    const controller = new AbortController()
    const { io, calls } = fakeIo({
      execution_run_get: [{ ok: true, value: { snapshot: snapshot(), resultExpired: false } }],
      execution_run_events: [{ ok: true, value: { events: [], lastSeq: 0, terminal: false } }],
    })
    io.sleep = async () => {
      controller.abort()
    }
    await followCompanionFusionRun(RUN, {
      io,
      signal: controller.signal,
      onUpdate: () => undefined,
    })
    expect(calls.filter((call) => call.command === "execution_run_events")).toHaveLength(1)
  })
})

describe("companionRunSummaryOf", () => {
  it("folds the contract events back into the desktop's run card summary", () => {
    const view: CompanionRunFollow = {
      ...emptyCompanionRunFollow(RUN),
      events: [
        event(1, "run.queued", { cap_microusd: 1_200_000 }),
        event(2, "route.selected", {
          action_id: "cascade_verifiable",
          mode: "cascade",
          rule_id: "cascade_verifiable",
          roles: { cheap: "fake::cheap", strong: "fake::strong" },
        }),
        // A journal type the contract has no name for travels as phase.changed.
        event(3, "phase.changed", { event: "cascade.escalated", reason: "VERIFICATION_FAILED" }),
        event(4, "phase.changed", { phase: "cascade", step: "strong" }),
        event(5, "billing.updated", {
          spent_microusd: 9_000,
          model_calls: 3,
          cost_status: "actual",
        }),
        event(6, "answer.completed", { quality_status: "accepted" }),
        event(7, "run.completed"),
      ],
      lastSeq: 7,
      terminal: true,
    }
    const summary = companionRunSummaryOf(view)
    expect(summary).toMatchObject({
      runId: RUN,
      mode: "cascade",
      actionId: "cascade_verifiable",
      ruleId: "cascade_verifiable",
      status: "succeeded",
      qualityStatus: "accepted",
      roles: { cheap: "fake::cheap", strong: "fake::strong" },
      capMicrousd: 1_200_000,
      spentMicrousd: 9_000,
      modelCalls: 3,
      costStatus: "actual",
      errorCode: null,
    })
    expect(summary.timeline.phases.map((phase) => phase.step)).toContain("strong")
  })

  it("prefers the snapshot's status and error once it has one", () => {
    const view: CompanionRunFollow = {
      ...emptyCompanionRunFollow(RUN),
      snapshot: snapshot({
        status: "failed",
        error: {
          code: "RUN_BUDGET_EXHAUSTED",
          message: "cap",
          retryable: false,
          details: {},
          trace_id: RUN,
        },
      }),
    }
    expect(companionRunSummaryOf(view)).toMatchObject({
      status: "failed",
      errorCode: "RUN_BUDGET_EXHAUSTED",
      capMicrousd: 1_200_000,
      spentMicrousd: 4_000,
    })
    expect(companionRunAnswerOf(view)).toBeNull()
  })
})

describe("cancelCompanionFusionRun", () => {
  it("stops through execution_run_control with a lease minted for this gesture", async () => {
    const issueLease = jest.fn(async () => ({ token: "lease-1" }))
    const { io, calls } = fakeIo({
      execution_run_control: [{ accepted: true, currentRevision: 9 }],
    })
    await expect(cancelCompanionFusionRun(RUN, 7, { ...io, issueLease })).resolves.toEqual({
      accepted: true,
      currentRevision: 9,
    })
    expect(issueLease).toHaveBeenCalledWith(["execution_run_control"], 120)
    expect(calls).toEqual([
      {
        command: "execution_run_control",
        args: {
          runId: RUN,
          action: "stop",
          idempotencyKey: `companion-run:${RUN}:stop:7`,
          expectedRevision: 7,
          adminLease: "lease-1",
        },
      },
    ])
  })

  it("reports a refused lease as a failed control, not a crash", async () => {
    const issueLease = jest.fn(async () => {
      throw Object.assign(new Error("consent needed"), { code: "host_consent_required" })
    })
    await expect(cancelCompanionFusionRun(RUN, 1, { issueLease })).resolves.toEqual({
      accepted: false,
      reason: "control_failed",
      code: "host_consent_required",
    })
  })
})
