import { ATTENTION_QUEUE_CAP, JobAttention, type JobExitEvent } from "./attention"

jest.mock("@/lib/tauri/events", () => ({
  TAURI_EVENTS: { backgroundJobExited: "jobs://exited" },
  onTauriEvent: jest.fn(async () => () => undefined),
}))

function exit(jobId: string, caller = "mcp:c1", extra: Partial<JobExitEvent> = {}): JobExitEvent {
  return {
    jobId,
    status: "exited",
    exitCode: 0,
    owner: { kind: "session", sessionId: `external-bridge:jobs:${caller}` },
    ...extra,
  }
}

describe("JobAttention", () => {
  it("routes an exit to the client that owns the job only", () => {
    const attention = new JobAttention(async () => () => undefined)
    attention.noteSpawned("j1", "pnpm")
    attention.record(exit("j1"))
    expect(attention.drain("mcp:c2")).toBeUndefined()
    expect(attention.drain("mcp:c1")).toEqual({
      jobs: [{ jobId: "j1", status: "exited", exitCode: 0, label: "pnpm" }],
    })
    // Delivered once.
    expect(attention.drain("mcp:c1")).toBeUndefined()
  })

  it("ignores jobs that are not bridge-owned", () => {
    const attention = new JobAttention(async () => () => undefined)
    attention.record({
      jobId: "x",
      status: "exited",
      owner: { kind: "session", sessionId: "chat-1" },
    })
    attention.record({ jobId: "y", status: "exited", owner: { kind: "scheduledTask" } })
    expect(attention.drain("chat-1")).toBeUndefined()
  })

  it("drops exits the client already observed", () => {
    const attention = new JobAttention(async () => () => undefined)
    attention.record(exit("j1"))
    attention.markObserved("mcp:c1", "j1")
    attention.markObserved("mcp:c1", "j2")
    attention.record(exit("j2"))
    expect(attention.drain("mcp:c1")).toBeUndefined()
  })

  it("respects the byte cap and reports what is still queued", () => {
    const attention = new JobAttention(async () => () => undefined)
    for (let i = 0; i < 5; i += 1) attention.record(exit(`job-${i}`))
    const first = attention.drain("mcp:c1", 100)!
    expect(first.jobs.length).toBeGreaterThan(0)
    expect(first.jobs.length).toBeLessThan(5)
    expect(first.more).toBe(5 - first.jobs.length)
    const rest = attention.drain("mcp:c1", 10_000)!
    expect(first.jobs.length + rest.jobs.length).toBe(5)
    expect(rest.more).toBeUndefined()
  })

  it("always delivers at least one oversized item", () => {
    const attention = new JobAttention(async () => () => undefined)
    attention.noteSpawned("j1", "x".repeat(500))
    attention.record(exit("j1"))
    expect(attention.drain("mcp:c1", 10)?.jobs).toHaveLength(1)
  })

  it("counts exits dropped by queue overflow", () => {
    const attention = new JobAttention(async () => () => undefined)
    for (let i = 0; i < ATTENTION_QUEUE_CAP + 3; i += 1) attention.record(exit(`j${i}`))
    const delivery = attention.drain("mcp:c1", 1_000_000)!
    expect(delivery.dropped).toBe(3)
    expect(delivery.jobs).toHaveLength(ATTENTION_QUEUE_CAP)
  })

  it("subscribes once and records from the feed; retries after a failed subscribe", async () => {
    let handler: ((event: JobExitEvent) => void) | undefined
    const subscribe = jest
      .fn<Promise<() => void>, [(event: JobExitEvent) => void]>()
      .mockRejectedValueOnce(new Error("no transport"))
      .mockImplementation(async (h) => {
        handler = h
        return () => undefined
      })
    const attention = new JobAttention(subscribe)
    await expect(attention.ensureSubscribed()).rejects.toThrow("no transport")
    await attention.ensureSubscribed()
    await attention.ensureSubscribed()
    expect(subscribe).toHaveBeenCalledTimes(2)
    handler?.(exit("j9"))
    expect(attention.drain("mcp:c1")?.jobs[0]?.jobId).toBe("j9")
  })
})

describe("JobAttention memory bounds", () => {
  it("forgets labels and observed ids once used, and caps what it remembers", async () => {
    const { ATTENTION_MEMORY_CAP } = await import("./attention")
    const attention = new JobAttention(async () => () => undefined)
    for (let i = 0; i < ATTENTION_MEMORY_CAP + 50; i += 1) attention.noteSpawned(`j${i}`, "x")
    // The oldest label was evicted: its exit arrives unlabelled.
    attention.record(exit("j0"))
    expect(attention.drain("mcp:c1")?.jobs[0]).toEqual({
      jobId: "j0",
      status: "exited",
      exitCode: 0,
    })
    // An observed id suppresses exactly one exit, then is forgotten.
    attention.markObserved("mcp:c1", "k")
    attention.record(exit("k"))
    attention.record(exit("k"))
    expect(attention.drain("mcp:c1")?.jobs).toHaveLength(1)
  })
})
