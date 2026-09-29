import type {
  IssueActivityEventData,
  IssueEvent,
  IssueRun,
  IssueStatus,
  IssueWakeupEvidence,
} from "@/types/issues"
import { ISSUE_WAKEUP_MAX_DEFERRED } from "@/types/issues"
import type { ScheduledTask } from "@/types/scheduler"
import {
  ISSUE_WAKEUP_DEFAULT_MAX_FIRES,
  ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR,
  appendDeferred,
  attributeIssueEvent,
  barrierAdvanced,
  buildWakeupBrief,
  chainOfInputs,
  childrenBarrier,
  compileIssueWakeup,
  decompileWakeupTrigger,
  describeBarrier,
  evidenceFromActivity,
  isOverWakeupRate,
  isPeriodicWakeup,
  isWakeupLoop,
  matchesWakeup,
  readActivityData,
  readBarrier,
  readWakeupPayload,
  summarizeIssueEventPayload,
  summarizeWakeupCues,
  summariseWakeup,
  type BarrierChild,
  type IssueWakeupSpec,
  effectiveWakeupInstruction,
  normalizeWakeupInstruction,
  ISSUE_WAKEUP_INSTRUCTION_MAX,
} from "./model"

const base: Omit<IssueWakeupSpec, "trigger"> = { issueId: "i1", instruction: "  Look again  " }

function task(
  over: Partial<ScheduledTask> & Pick<ScheduledTask, "trigger" | "payload">
): ScheduledTask {
  return {
    id: "w1",
    name: "w",
    type: "issue-wakeup",
    config: { timeout: 1, maxRetries: 0, retryDelay: 0, runMissedOnStartup: false, maxRuns: 20 },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

function data(over: Partial<IssueActivityEventData> = {}): IssueActivityEventData {
  return {
    issueId: "i1",
    subjectId: "i1",
    kind: "commented",
    ts: 1_000,
    chain: [],
    summary: "comment: hi",
    ...over,
  }
}

describe("compileIssueWakeup", () => {
  it("compiles an event rule onto the issue's own source with the match in the payload", () => {
    const compiled = compileIssueWakeup({
      ...base,
      trigger: { on: "event", kinds: ["commented"], actorKinds: ["human"] },
    })
    expect(compiled.trigger).toEqual({
      type: "event",
      eventType: "issue:activity",
      eventSource: "issue:i1",
    })
    expect(compiled.payload).toEqual({
      issueId: "i1",
      instruction: "Look again",
      match: { kinds: ["commented"], actorKinds: ["human"] },
    })
    expect(compiled.config).toMatchObject({
      maxRuns: ISSUE_WAKEUP_DEFAULT_MAX_FIRES,
      maxRetries: 0,
      overlapPolicy: "queue-all",
    })
  })

  it("makes the two condition triggers one-shot by default, and lets the author opt out", () => {
    expect(compileIssueWakeup({ ...base, trigger: { on: "children-done" } }).payload).toMatchObject(
      {
        once: true,
        condition: { kind: "children-done" },
        match: { kinds: ["child_status_changed", "child_stage_changed"] },
      }
    )
    expect(
      compileIssueWakeup({ ...base, trigger: { on: "children-done" }, once: false }).payload.once
    ).toBeUndefined()
  })

  it("points an issue-finished rule at the WATCHED issue's source but keeps its own issue", () => {
    const compiled = compileIssueWakeup({
      ...base,
      trigger: { on: "issue-finished", targetIssueId: "i2" },
    })
    expect(compiled.trigger.eventSource).toBe("issue:i2")
    expect(compiled.payload.issueId).toBe("i1")
    expect(compiled.payload.condition).toEqual({ kind: "issue-finished", issueId: "i2" })
  })

  it("compiles timers to plain scheduler triggers; `at` is always once", () => {
    expect(
      compileIssueWakeup({
        ...base,
        trigger: { on: "cron", cronExpression: "0 9 * * *", timezone: "UTC" },
      }).trigger
    ).toEqual({ type: "cron", cronExpression: "0 9 * * *", timezone: "UTC" })
    expect(
      compileIssueWakeup({ ...base, trigger: { on: "interval", intervalMs: 60_000 } }).trigger
    ).toEqual({
      type: "interval",
      intervalMs: 60_000,
    })
    const at = new Date("2030-01-01T00:00:00Z")
    const once = compileIssueWakeup({ ...base, trigger: { on: "at", runAt: at } })
    expect(once.trigger).toEqual({ type: "once", runAt: at })
    expect(once.payload.once).toBe(true)
  })

  it("carries expiry as endAt", () => {
    const expiresAt = new Date("2030-01-01T00:00:00Z")
    expect(compileIssueWakeup({ ...base, trigger: { on: "event" }, expiresAt }).endAt).toEqual(
      expiresAt
    )
  })

  it("wakes on timeout only with a deadline, and drops by default", () => {
    const expiresAt = new Date("2030-01-01T00:00:00Z")
    const event = { on: "event" } as const
    expect(
      compileIssueWakeup({ ...base, trigger: event, expiresAt, onTimeout: "wake" }).payload
    ).toMatchObject({ onTimeout: "wake" })
    expect(
      compileIssueWakeup({ ...base, trigger: event, expiresAt, onTimeout: "drop" }).payload
    ).not.toHaveProperty("onTimeout")
    expect(() => compileIssueWakeup({ ...base, trigger: event, onTimeout: "wake" })).toThrow(
      /deadline/
    )
  })

  it.each([
    [{ ...base, instruction: "   " }, /instruction/],
    [{ ...base, maxFires: 0 }, /maxFires/],
    [{ ...base, maxFires: 1001 }, /maxFires/],
  ])("refuses a rule it could never honour", (spec, message) => {
    expect(() => compileIssueWakeup({ ...spec, trigger: { on: "event" } })).toThrow(message)
  })

  it("compiles a pr-merged rule onto the issue's own source, one-shot by default", () => {
    expect(compileIssueWakeup({ ...base, trigger: { on: "pr-merged" } })).toMatchObject({
      trigger: { type: "event", eventType: "issue:activity", eventSource: "issue:i1" },
      payload: {
        once: true,
        match: { kinds: ["pr_state_changed"] },
        condition: { kind: "pr-merged" },
      },
    })
  })

  it("compiles a pr-checks rule onto the issue's own source, one-shot, with its outcome", () => {
    expect(compileIssueWakeup({ ...base, trigger: { on: "pr-checks" } })).toMatchObject({
      trigger: { type: "event", eventType: "issue:activity", eventSource: "issue:i1" },
      payload: {
        once: true,
        match: { kinds: ["pr_checks_changed"] },
        condition: { kind: "pr-checks" },
      },
    })
    expect(
      compileIssueWakeup({ ...base, trigger: { on: "pr-checks", result: "failing" }, once: false })
        .payload
    ).toMatchObject({ condition: { kind: "pr-checks", result: "failing" } })
    expect(
      compileIssueWakeup({ ...base, trigger: { on: "pr-checks", result: "failing" }, once: false })
        .payload.once
    ).toBeUndefined()
  })

  it("scopes a children-done rule to a stage, and refuses a stage that is not one", () => {
    expect(
      compileIssueWakeup({ ...base, trigger: { on: "children-done", stage: 2 } }).payload.condition
    ).toEqual({ kind: "children-done", stage: 2 })
    expect(() =>
      compileIssueWakeup({ ...base, trigger: { on: "children-done", stage: 0 } })
    ).toThrow(/stage/)
    expect(() =>
      compileIssueWakeup({ ...base, trigger: { on: "children-done", stage: 1.5 } })
    ).toThrow(/stage/)
  })

  it("refuses an issue-finished rule watching its own issue", () => {
    expect(() =>
      compileIssueWakeup({ ...base, trigger: { on: "issue-finished", targetIssueId: "i1" } })
    ).toThrow(/own issue/)
  })
})

describe("decompileWakeupTrigger", () => {
  it.each([
    [{ on: "event", kinds: ["commented"], toStatuses: ["done"] }],
    [{ on: "children-done" }],
    [{ on: "children-done", stage: 2 }],
    [{ on: "issue-finished", targetIssueId: "i2" }],
    [{ on: "pr-merged" }],
    [{ on: "pr-checks" }],
    [{ on: "pr-checks", result: "passing" }],
    [{ on: "cron", cronExpression: "0 9 * * *" }],
    [{ on: "interval", intervalMs: 3_600_000 }],
  ] as const)("round-trips %o", (trigger) => {
    const compiled = compileIssueWakeup({ ...base, trigger: trigger as IssueWakeupSpec["trigger"] })
    expect(decompileWakeupTrigger(compiled)).toEqual(trigger)
  })
})

describe("the sub-issue barrier", () => {
  const child = (id: string, status: IssueStatus, stage?: number): BarrierChild => ({
    id,
    status,
    ...(stage !== undefined ? { stage } : {}),
  })

  it("is not reached without children, and reached as `all` when every child finished", () => {
    expect(childrenBarrier([])).toBeUndefined()
    expect(childrenBarrier([child("a", "done"), child("b", "todo")])).toBeUndefined()
    expect(childrenBarrier([child("a", "done"), child("b", "canceled")])).toEqual({ kind: "all" })
  })

  it("scopes an author's stage to staged children of that stage or lower", () => {
    const children = [
      child("a", "done", 1),
      child("b", "done", 2),
      child("c", "todo", 3),
      child("u", "todo"),
    ]
    expect(childrenBarrier(children, { stage: 2 })).toEqual({ kind: "stage", stage: 2 })
    expect(childrenBarrier(children, { stage: 3 })).toBeUndefined()
    // An empty stage never holds.
    expect(childrenBarrier(children, { stage: 5 })).toBeUndefined()
  })

  it("hands off stage by stage for the platform rule, and waits for unstaged work at the end", () => {
    const eachStage = { eachStage: true }
    expect(
      childrenBarrier([child("a", "done", 1), child("b", "todo", 2), child("u", "todo")], eachStage)
    ).toEqual({ kind: "stage", stage: 1 })
    expect(
      childrenBarrier(
        [child("a", "done", 1), child("b", "done", 2), child("c", "todo", 3)],
        eachStage
      )
    ).toEqual({ kind: "stage", stage: 2 })
    // Every stage done but an unstaged child open: nobody to hand off to yet.
    expect(childrenBarrier([child("a", "done", 1), child("u", "todo")], eachStage)).toBeUndefined()
    expect(
      childrenBarrier([child("a", "todo", 1), child("b", "todo", 2)], eachStage)
    ).toBeUndefined()
    expect(childrenBarrier([child("a", "done", 1), child("u", "done")], eachStage)).toEqual({
      kind: "all",
    })
  })

  it("only an advance counts", () => {
    const stage1 = { kind: "stage", stage: 1 } as const
    const stage2 = { kind: "stage", stage: 2 } as const
    expect(barrierAdvanced(undefined, stage1)).toBe(true)
    expect(barrierAdvanced(stage1, stage2)).toBe(true)
    expect(barrierAdvanced(stage2, { kind: "all" })).toBe(true)
    expect(barrierAdvanced(stage1, stage1)).toBe(false)
    expect(barrierAdvanced({ kind: "all" }, { kind: "all" })).toBe(false)
    expect(barrierAdvanced(stage2, stage1)).toBe(false)
    expect(barrierAdvanced(stage1, undefined)).toBe(false)
  })

  it("reads a barrier back from a fire payload and describes it for the agent", () => {
    expect(readBarrier({ kind: "stage", stage: 2 })).toEqual({ kind: "stage", stage: 2 })
    expect(readBarrier({ kind: "all" })).toEqual({ kind: "all" })
    expect(readBarrier({ kind: "stage", stage: 0 })).toBeUndefined()
    expect(readBarrier("all")).toBeUndefined()
    expect(describeBarrier({ kind: "stage", stage: 2 })).toMatch(/stage 2 and every earlier/)
    expect(describeBarrier({ kind: "all" })).toBe("All sub-issues are finished.")
  })
})

describe("matchesWakeup", () => {
  it("matches anything without a match", () => {
    expect(matchesWakeup(undefined, data())).toBe(true)
  })

  it("filters on kind, actor kind and target status", () => {
    const match = {
      kinds: ["status_changed" as const],
      actorKinds: ["human" as const],
      toStatuses: ["done" as const],
    }
    const ok = data({ kind: "status_changed", actor: { kind: "human" }, to: "done" })
    expect(matchesWakeup(match, ok)).toBe(true)
    expect(matchesWakeup(match, { ...ok, kind: "commented" })).toBe(false)
    expect(matchesWakeup(match, { ...ok, actor: { kind: "agent", id: "a" } })).toBe(false)
    expect(matchesWakeup(match, { ...ok, actor: undefined })).toBe(false)
    expect(matchesWakeup(match, { ...ok, to: "todo" })).toBe(false)
  })
})

describe("runaway protection", () => {
  it("calls it a loop once the rule already appears twice on the incoming chain", () => {
    expect(isWakeupLoop(["w1", "w2"], "w1")).toBe(false)
    expect(isWakeupLoop(["w1", "w2", "w1"], "w1")).toBe(true)
  })

  it("counts only the last hour's prior fires against the cap", () => {
    const now = 10 * 3_600_000
    const recent = Array.from(
      { length: ISSUE_WAKEUP_RATE_LIMIT_PER_HOUR - 1 },
      (_, i) => new Date(now - i * 1000)
    )
    expect(isOverWakeupRate(recent, now)).toBe(false)
    expect(isOverWakeupRate([...recent, new Date(now - 5)], now)).toBe(true)
    expect(isOverWakeupRate([...recent, new Date(now - 2 * 3_600_000)], now)).toBe(false)
  })

  it("continues the longest chain among a fire's inputs", () => {
    const evidence = (chain: string[]): IssueWakeupEvidence => ({
      kind: "commented",
      subjectId: "i1",
      ts: 1,
      summary: "",
      chain,
    })
    expect(chainOfInputs([evidence(["a"]), evidence(["a", "b"]), evidence([])])).toEqual(["a", "b"])
    expect(chainOfInputs([])).toEqual([])
  })

  it("bounds held inputs, dropping the oldest", () => {
    let held: IssueWakeupEvidence[] = []
    for (let i = 0; i < ISSUE_WAKEUP_MAX_DEFERRED + 3; i++) {
      held = appendDeferred(held, {
        kind: "commented",
        subjectId: "i1",
        ts: i,
        summary: String(i),
        chain: [],
      })
    }
    expect(held).toHaveLength(ISSUE_WAKEUP_MAX_DEFERRED)
    expect(held[0]!.ts).toBe(3)
  })
})

describe("attributeIssueEvent", () => {
  const run = (over: Partial<IssueRun>): IssueRun => ({
    id: "r1",
    issueId: "i1",
    projectId: "w",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "task-1",
    status: "running",
    by: { kind: "human" },
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    ...over,
  })
  const event = (payload: IssueEvent["payload"]): Pick<IssueEvent, "payload"> => ({ payload })

  it("uses the run an entry names", () => {
    const runs = [run({ id: "r1" }), run({ id: "r2" })]
    expect(
      attributeIssueEvent(
        event({ kind: "run_failed", runId: "r2", adapterId: "x", error: "e" }),
        runs,
        undefined
      )?.id
    ).toBe("r2")
  })

  it("attributes a runtime actor (the engine target) to its run, active or settled", () => {
    const runs = [run({ id: "r1", status: "succeeded" })]
    const status = event({
      kind: "status_changed",
      from: "in_progress",
      to: "in_review",
      by: { kind: "agent", id: "task-1" },
    })
    expect(attributeIssueEvent(status, runs, undefined)?.id).toBe("r1")
  })

  it("attributes the assignee agent acting during an active run to that run", () => {
    const runs = [run({ id: "r1" })]
    const comment = event({
      kind: "commented",
      commentId: "c",
      body: "b",
      by: { kind: "agent", id: "char-1" },
    })
    expect(attributeIssueEvent(comment, runs, { kind: "agent", id: "char-1" })?.id).toBe("r1")
    expect(
      attributeIssueEvent(comment, runs, { kind: "agent", id: "someone-else" })
    ).toBeUndefined()
  })

  it("never attributes a person", () => {
    const comment = event({ kind: "commented", commentId: "c", body: "b", by: { kind: "human" } })
    expect(attributeIssueEvent(comment, [run({})], { kind: "human" })).toBeUndefined()
  })
})

describe("reading payloads and activity", () => {
  it("rejects a payload without issue and instruction", () => {
    expect(readWakeupPayload({ issueId: "i1" })).toBeUndefined()
    expect(readWakeupPayload(null)).toBeUndefined()
    expect(readWakeupPayload({ issueId: "i1", instruction: "x" })).toEqual({
      issueId: "i1",
      instruction: "x",
    })
  })

  it("defaults a missing chain and subject", () => {
    expect(readActivityData({ issueId: "i1", kind: "commented" })).toMatchObject({
      subjectId: "i1",
      chain: [],
      summary: "commented",
    })
    expect(readActivityData({ kind: "x" })).toBeUndefined()
  })

  it("turns activity into bounded evidence", () => {
    const evidence = evidenceFromActivity(data({ summary: "x".repeat(1000), chain: ["a"] }))
    expect(evidence.summary.length).toBeLessThanOrEqual(280)
    expect(evidence.chain).toEqual(["a"])
  })
})

describe("summarizeIssueEventPayload", () => {
  it("renders one line per kind", () => {
    expect(
      summarizeIssueEventPayload({
        kind: "status_changed",
        from: "todo",
        to: "done",
        by: { kind: "human" },
      })
    ).toBe("status todo → done")
    expect(
      summarizeIssueEventPayload({
        kind: "commented",
        commentId: "c",
        body: "a\n\nb",
        by: { kind: "human" },
      })
    ).toBe("comment: a b")
    expect(summarizeIssueEventPayload({ kind: "created", by: { kind: "human" } })).toBe("created")
  })
})

describe("buildWakeupBrief", () => {
  const input = {
    taskId: "w1",
    instruction: "Answer the question.",
    identifier: "MERC-1",
    inputs: [
      {
        kind: "child_status_changed" as const,
        subjectId: "i2",
        ts: 0,
        actor: { kind: "human" as const, label: "Ada" },
        summary: "status todo → done",
        chain: [],
      },
    ],
    joined: false,
    periodic: false,
    identifiersById: new Map([["i2", "MERC-2"]]),
  }

  it("marks the brief, states the instruction and lists what happened, naming other issues", () => {
    const brief = buildWakeupBrief(input)
    expect(brief.split("\n")[0]).toBe("[WAKEUP w1] MERC-1")
    expect(brief).toContain("Answer the question.")
    expect(brief).toContain("child_status_changed on MERC-2 by Ada: status todo → done")
    expect(brief).not.toContain("issue_wakeup_checkin")
  })

  it("says which sub-issue hand-off this is", () => {
    expect(buildWakeupBrief({ ...input, barrier: { kind: "stage", stage: 1 } })).toContain(
      "Sub-issue stage 1 and every earlier stage are finished."
    )
    expect(buildWakeupBrief(input)).not.toContain("Sub-issue stage")
  })

  it("says it joined, and tells a periodic run how to check in", () => {
    const brief = buildWakeupBrief({ ...input, joined: true, periodic: true })
    expect(brief.split("\n")[0]).toBe("[WAKEUP w1 — joined this run] MERC-1")
    expect(brief).toContain('issue_wakeup_checkin with wakeupId "w1"')
  })

  it("keeps only the newest inputs and says how many it left out", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      ...input.inputs[0]!,
      ts: i,
      summary: `s${i}`,
    }))
    const brief = buildWakeupBrief({ ...input, inputs: many })
    expect(brief).toContain("(3 earlier input(s) omitted)")
    expect(brief).not.toContain(": s2\n")
    expect(brief).toContain(": s12")
  })
})

describe("cues and agent summaries", () => {
  const rule = (over: Partial<ScheduledTask>, payload: Record<string, unknown> = {}) =>
    task({
      trigger: { type: "event", eventType: "issue:activity" },
      payload: { issueId: "i1", instruction: "x", ...payload },
      ...over,
    })

  it("folds rules into one cue per issue and leaves platform rules out", () => {
    const cues = summarizeWakeupCues([
      rule(
        { id: "a" },
        { deferred: [{ kind: "commented", subjectId: "i1", ts: 1, summary: "", chain: [] }] }
      ),
      rule({ id: "b", status: "paused", lastTerminalReason: "wakeup-paused-loop" }),
      rule({ id: "c" }, { system: "children-done" }),
      rule({ id: "d", status: "expired" }),
    ])
    expect(cues.get("i1")).toEqual({ active: 1, paused: 1, pauseReason: "loop", held: 1 })
  })

  it("keeps the soonest timer", () => {
    const soon = new Date(1_000)
    const cues = summarizeWakeupCues([
      rule({ id: "a", nextRunAt: new Date(5_000) }),
      rule({ id: "b", nextRunAt: soon }),
    ])
    expect(cues.get("i1")?.nextRunAt).toEqual(soon)
  })

  it("summarises a rule for an agent, naming a manual pause as such", () => {
    expect(summariseWakeup(rule({ status: "paused" }))).toMatchObject({
      wakeupId: "w1",
      issueId: "i1",
      status: "paused",
      pauseReason: "manual",
      trigger: { on: "event" },
    })
  })

  it("knows which triggers are periodic", () => {
    expect(isPeriodicWakeup({ trigger: { type: "cron", cronExpression: "* * * * *" } })).toBe(true)
    expect(isPeriodicWakeup({ trigger: { type: "interval", intervalMs: 1 } })).toBe(true)
    expect(isPeriodicWakeup({ trigger: { type: "event" } })).toBe(false)
  })
})

describe("effectiveWakeupInstruction", () => {
  const platform = { instruction: "Built-in.", system: "children-done" as const }
  it("falls back from the parent's override to the project default to the built-in text", () => {
    expect(effectiveWakeupInstruction(platform)).toBe("Built-in.")
    expect(effectiveWakeupInstruction(platform, { childrenDoneInstruction: " Project. " })).toBe(
      "Project."
    )
    expect(
      effectiveWakeupInstruction(
        { ...platform, instructionOverride: "Mine." },
        { childrenDoneInstruction: "Project." }
      )
    ).toBe("Mine.")
    // Blank layers are skipped rather than handing the agent nothing.
    expect(
      effectiveWakeupInstruction(
        { ...platform, instructionOverride: "  " },
        { childrenDoneInstruction: "" }
      )
    ).toBe("Built-in.")
  })

  it("leaves an author's rule to its own words", () => {
    expect(
      effectiveWakeupInstruction(
        { instruction: "Author.", instructionOverride: "ignored" },
        { childrenDoneInstruction: "Project." }
      )
    ).toBe("Author.")
  })
})

describe("normalizeWakeupInstruction", () => {
  it("trims, and refuses empty or overlong text", () => {
    expect(normalizeWakeupInstruction("  go  ")).toBe("go")
    expect(() => normalizeWakeupInstruction("   ")).toThrow(/needs an instruction/)
    expect(() => normalizeWakeupInstruction("x".repeat(ISSUE_WAKEUP_INSTRUCTION_MAX + 1))).toThrow(
      /limited/
    )
  })
})
