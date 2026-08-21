import {
  deterministicTriggerIdempotencyKey,
  isSharedTriggerKind,
  scheduledOccurrenceIdempotencyKey,
} from "./trigger-idempotency"

describe("deterministicTriggerIdempotencyKey", () => {
  it("gives two hosts the same key for one cron occurrence", () => {
    // This is the whole point: without it each host minted a random invocation
    // id, the ledger lookup was skipped, and the workflow ran twice.
    const hostA = deterministicTriggerIdempotencyKey({
      workflowId: "wf_1",
      triggerKind: "trigger.cron",
      triggerId: "t_1",
      originAt: 1_700_000_000_000,
    })
    const hostB = deterministicTriggerIdempotencyKey({
      workflowId: "wf_1",
      triggerKind: "trigger.cron",
      triggerId: "t_1",
      originAt: 1_700_000_000_000,
    })
    expect(hostA).toBe(hostB)
    expect(hostA).toBeDefined()
  })

  it("absorbs sub-second clock skew between hosts", () => {
    const early = deterministicTriggerIdempotencyKey({
      workflowId: "wf_1",
      triggerKind: "trigger.cron",
      triggerId: "t_1",
      originAt: 1_700_000_000_010,
    })
    const late = deterministicTriggerIdempotencyKey({
      workflowId: "wf_1",
      triggerKind: "trigger.cron",
      triggerId: "t_1",
      originAt: 1_700_000_000_990,
    })
    expect(early).toBe(late)
  })

  it("keeps genuinely distinct occurrences apart", () => {
    // Cron cannot fire the same trigger twice inside one second, so a second is
    // the finest granularity that can never merge two real fires.
    const first = deterministicTriggerIdempotencyKey({
      workflowId: "wf_1",
      triggerKind: "trigger.cron",
      triggerId: "t_1",
      originAt: 1_700_000_000_000,
    })
    const second = deterministicTriggerIdempotencyKey({
      workflowId: "wf_1",
      triggerKind: "trigger.cron",
      triggerId: "t_1",
      originAt: 1_700_000_001_000,
    })
    expect(first).not.toBe(second)
  })

  it("scopes the key to one trigger on the workflow", () => {
    const base = { workflowId: "wf_1", triggerKind: "trigger.cron", originAt: 1_700_000_000_000 }
    expect(deterministicTriggerIdempotencyKey({ ...base, triggerId: "a" })).not.toBe(
      deterministicTriggerIdempotencyKey({ ...base, triggerId: "b" })
    )
    expect(
      deterministicTriggerIdempotencyKey({ ...base, workflowId: "wf_2", triggerId: "a" })
    ).not.toBe(deterministicTriggerIdempotencyKey({ ...base, triggerId: "a" }))
  })

  it("refuses to deduplicate an inherently single-host trigger", () => {
    // Two manual clicks are two runs. Collapsing them would swallow one the
    // user explicitly asked for.
    for (const kind of ["trigger.manual", "trigger.chat", "trigger.plugin"]) {
      expect(isSharedTriggerKind(kind)).toBe(false)
      expect(
        deterministicTriggerIdempotencyKey({
          workflowId: "wf_1",
          triggerKind: kind,
          originAt: 1_700_000_000_000,
        })
      ).toBeUndefined()
    }
  })

  it("declines rather than inventing an instant when none was supplied", () => {
    expect(
      deterministicTriggerIdempotencyKey({ workflowId: "wf_1", triggerKind: "trigger.cron" })
    ).toBeUndefined()
    expect(
      deterministicTriggerIdempotencyKey({
        workflowId: "wf_1",
        triggerKind: "trigger.cron",
        originAt: Number.NaN,
      })
    ).toBeUndefined()
  })
})

describe("scheduledOccurrenceIdempotencyKey", () => {
  it("keys on the occurrence, not the per-host execution row", () => {
    // `${taskId}:${executionId}` was the old key, and the execution row is
    // minted locally — which is exactly how one cron tick ran on two machines.
    const hostA = scheduledOccurrenceIdempotencyKey({
      taskId: "task_1",
      scheduledFor: 1_700_000_000_000,
      fallbackExecutionId: "exec_host_a",
    })
    const hostB = scheduledOccurrenceIdempotencyKey({
      taskId: "task_1",
      scheduledFor: 1_700_000_000_000,
      fallbackExecutionId: "exec_host_b",
    })
    expect(hostA).toBe(hostB)
    expect(hostA).not.toContain("exec_host")
  })

  it("keeps ad-hoc runs distinct, because two of them really are two runs", () => {
    const first = scheduledOccurrenceIdempotencyKey({
      taskId: "task_1",
      fallbackExecutionId: "exec_1",
    })
    const second = scheduledOccurrenceIdempotencyKey({
      taskId: "task_1",
      fallbackExecutionId: "exec_2",
    })
    expect(first).not.toBe(second)
  })
})
