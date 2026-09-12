import { executeWork, parseReport } from "./execute"
import { fixture, SHA } from "./test-fixtures"
import { monitor } from "./monitor"

it("publishes only the exact approved patch and PR content", async () => {
  const f = fixture()
  const result = await executeWork(f.context, f.run, f.config)
  expect(result.output.status).toBe("published")
  expect(f.mocks.publish).toHaveBeenCalledWith(expect.anything(), {
    approvalId: "approval",
    snapshotId: "snapshot",
    message: "fix: resolve issue #7",
    branch: expect.stringContaining("codex/github-devin/"),
  })
  const approved = (
    f.mocks.approval.mock.calls[0] as unknown as [
      string,
      { detail: { approvedActions: Array<{ input: unknown }> } },
    ]
  )[1].detail.approvedActions[0].input
  expect(f.mocks.action).toHaveBeenCalledWith(
    expect.objectContaining({
      input: approved,
      binding: { runId: "run", slotId: "github" },
      approval: { interruptId: "approval" },
    })
  )
  expect(f.mocks.agent).toHaveBeenCalledWith(
    "devin",
    expect.any(String),
    expect.objectContaining({ model: "swe-2-medium", runId: "run", invocationId: "attempt-1" })
  )
})
it.each(["denied", "expired", "cancelled"])("never writes after %s", async (outcome) => {
  const f = fixture()
  f.mocks.approval.mockResolvedValue({ outcome, decidedAt: 1, approvalId: "approval" })
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe(outcome)
  expect(f.mocks.publish).not.toHaveBeenCalled()
  expect(f.mocks.action).not.toHaveBeenCalled()
})
it("invalidates approval when the target head changes during the wait", async () => {
  const f = fixture("review")
  f.mocks.approval.mockImplementation(async () => {
    f.item.head!.sha = "c".repeat(40)
    return { outcome: "approved", decidedAt: 1, approvalId: "approval" }
  })
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("stale")
  expect(f.mocks.action).not.toHaveBeenCalled()
})
it("replays completed agent and snapshot steps after process recovery", async () => {
  const f = fixture()
  f.mocks.approval.mockRejectedValueOnce(new Error("parked"))
  await expect(executeWork(f.context, f.run, f.config)).rejects.toThrow("parked")
  await executeWork(f.context, f.run, f.config)
  expect(f.mocks.agent).toHaveBeenCalledTimes(1)
  expect(f.mocks.snapshot).toHaveBeenCalledTimes(1)
})
it("recovers an uncertain review from GitHub instead of posting a duplicate", async () => {
  const f = fixture("review")
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.approval.mockImplementation(async () => {
    f.mocks.request.mockImplementation((binding, url) =>
      url.includes("/reviews")
        ? Promise.resolve({
            status: 200,
            headers: {},
            data: [
              {
                body: `${f.report.review}\n\n<!-- cognia-github-devin:${f.config.repository.toLowerCase()}/pr/8/review/${SHA} -->`,
                commit_id: SHA,
              },
            ],
          })
        : normal(binding, url)
    )
    return { outcome: "approved", decidedAt: 1, approvalId: "approval" }
  })
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("published")
  expect(f.mocks.action).not.toHaveBeenCalled()
})
it("blocks repairs with absent/failing reported tests after two attempts", async () => {
  const f = fixture()
  f.report.tests[0].exitCode = 1
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("blocked")
  expect(f.mocks.agent).toHaveBeenCalledTimes(2)
  expect(f.mocks.approval).not.toHaveBeenCalled()
})
it("retains the patch when a PR fork is not bound for publication", async () => {
  const f = fixture("repair")
  f.item.head!.repo!.full_name = "someone/fork"
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("blocked")
  expect(f.mocks.snapshot).toHaveBeenCalled()
  expect(f.mocks.publish).not.toHaveBeenCalled()
})
it("rejects malformed model results, unsuccessful execution, and review mutations", async () => {
  expect(() => parseReport("done")).toThrow()
  expect(() => parseReport('{"summary":"ok"}')).toThrow()
  const f = fixture()
  f.mocks.agent.mockResolvedValue({
    sessionId: "s",
    agentId: "devin",
    model: "swe-2-medium",
    status: "failed",
    text: "",
    toolCalls: [],
  })
  await expect(executeWork(f.context, f.run, f.config)).rejects.toThrow("Devin failed")
  const review = fixture("review")
  review.snapshot.diff = "+unexpected"
  await expect(executeWork(review.context, review.run, review.config)).rejects.toThrow(
    "unexpectedly modified"
  )
})
it("skips obsolete revisions and surfaces nonterminal broker jobs for durable retry", async () => {
  const old = fixture("review")
  old.item.head!.sha = "c".repeat(40)
  expect((await executeWork(old.context, old.run, old.config)).output.status).toBe("skipped")
  expect(old.mocks.agent).not.toHaveBeenCalled()
  const f = fixture("review")
  f.mocks.action.mockResolvedValue({
    id: "job",
    status: "retry_wait",
    output: {} as { number: number },
  })
  await expect(executeWork(f.context, f.run, f.config)).rejects.toThrow("retry_wait")
})

it("retains a diagnosis without inventing a patch when no code change is appropriate", async () => {
  const f = fixture("repair")
  f.report.changesNeeded = false
  f.snapshot.diff = ""
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("diagnosed")
  expect(f.mocks.approval).not.toHaveBeenCalled()
})
it("skips closed/draft, self-produced, and exhausted follow-up tasks", async () => {
  const closed = fixture()
  closed.item.state = "closed"
  expect((await executeWork(closed.context, closed.run, closed.config)).output.status).toBe(
    "skipped"
  )
  const self = fixture()
  self.item.body = "<!-- cognia-github-devin:owned -->"
  expect((await executeWork(self.context, self.run, self.config)).output.status).toBe("skipped")
  const capped = fixture("repair")
  capped.memory.set(`published:v1:install:${capped.config.repository.toLowerCase()}:8`, {
    attempts: 2,
  })
  expect((await executeWork(capped.context, capped.run, capped.config)).output.status).toBe(
    "skipped"
  )
})
it("does not repair an obsolete CI failure", async () => {
  const f = fixture("repair")
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.request.mockImplementation((binding, url) =>
    url.includes("/actions/runs?")
      ? Promise.resolve({ status: 200, headers: {}, data: { workflow_runs: [] } })
      : normal(binding, url)
  )
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("skipped")
  expect(f.mocks.agent).not.toHaveBeenCalled()
})
it("requires verifiable approval identity and nonempty review content", async () => {
  const f = fixture("review")
  f.mocks.approval.mockResolvedValue({ outcome: "approved", decidedAt: 1, approvalId: "" })
  await expect(executeWork(f.context, f.run, f.config)).rejects.toThrow("verifiable approval")
  const empty = fixture("review")
  empty.report.review = ""
  await expect(executeWork(empty.context, empty.run, empty.config)).rejects.toThrow(
    "Review result is empty"
  )
})

it("executes a queued monitor delivery through approval and remote publication", async () => {
  const f = fixture()
  f.run.event.triggerId = "poll"
  f.run.event.source = "schedule"
  await monitor(f.context, f.run, f.config)
  const queued = (f.mocks.enqueue.mock.calls[0] as unknown as [string, { payload: unknown }])[1]
  f.run.event.triggerId = "work"
  f.run.event.source = "bot"
  f.run.event.payload = queued.payload
  f.memo.clear()
  const result = await executeWork(f.context, f.run, f.config)
  expect(result.output.status).toBe("published")
  expect(
    f.memory.get(`published:v1:install:${f.config.repository.toLowerCase()}:42`)
  ).toMatchObject({ attempts: 0, parentNumber: 7 })
})

it("captures executable-only changes even if a renderer provides no textual diff", async () => {
  const f = fixture()
  f.snapshot.diff = ""
  f.snapshot.files = [
    {
      path: "script.sh",
      oldContent: "exit 0",
      newContent: "exit 0",
      status: "modified",
      mode: "100755",
    },
  ] as never[]
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("published")
})

it("sends an existing matching PR through the broker's approved-head gate", async () => {
  const f = fixture()
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.approval.mockImplementation(async () => {
    const request = (
      f.mocks.approval.mock.calls[0] as unknown as [
        string,
        { detail: { approvedActions: Array<{ input: Record<string, unknown> }> } },
      ]
    )[1]
    const input = request.detail.approvedActions[0].input
    f.mocks.request.mockImplementation((binding, url) =>
      url.includes("head=")
        ? Promise.resolve({
            status: 200,
            headers: {},
            data: [
              {
                number: 42,
                body: input.body,
                head: { ref: input.head, sha: "c".repeat(40) },
                base: { ref: input.base },
              },
            ],
          })
        : normal(binding, url)
    )
    return { outcome: "approved", decidedAt: 1, approvalId: "approval" }
  })
  f.mocks.action.mockRejectedValue(
    new Error("Published branch does not match the approved host checkpoint")
  )
  await expect(executeWork(f.context, f.run, f.config)).rejects.toThrow("approved host checkpoint")
  expect(f.mocks.action).toHaveBeenCalledTimes(1)
  expect(f.memory.has(`published:v1:install:${f.config.repository.toLowerCase()}:42`)).toBe(false)
})

it("does not report success when a PR head changes after the broker returned", async () => {
  const f = fixture()
  const action = f.mocks.action.getMockImplementation()!
  f.mocks.action.mockImplementation(async (input) => {
    const job = await action(input)
    const normal = f.mocks.request.getMockImplementation()!
    f.mocks.request.mockImplementation((binding, url) =>
      url.includes("head=")
        ? Promise.resolve({
            status: 200,
            headers: {},
            data: [
              {
                number: 42,
                body: input.input.body,
                head: { ref: input.input.head, sha: "c".repeat(40) },
                base: { ref: input.input.base },
              },
            ],
          })
        : normal(binding, url)
    )
    return job
  })
  const result = await executeWork(f.context, f.run, f.config)
  expect(result.output).toMatchObject({
    status: "blocked",
    publishedBranch: { headSha: SHA },
    observedHeadSha: "c".repeat(40),
  })
  expect(f.memory.has(`published:v1:install:${f.config.repository.toLowerCase()}:42`)).toBe(false)
})

it.each([false, true])(
  "retains uncertain-session recovery instead of redispatching (snapshot unavailable: %s)",
  async (unavailable) => {
    const f = fixture()
    f.mocks.agent.mockResolvedValue({
      sessionId: "uncertain-session",
      agentId: "devin",
      model: "swe-2-medium",
      status: "recovery_required",
      text: "Partial output is not a completed JSON report",
      toolCalls: [],
    })
    if (unavailable) f.mocks.snapshot.mockRejectedValue(new Error("Binary file cannot be captured"))
    const result = await executeWork(f.context, f.run, f.config)
    expect(result.output).toMatchObject({
      status: "blocked",
      reasonCode: "recovery_required",
      sessionId: "uncertain-session",
      model: "swe-2-medium",
      guidance: expect.stringContaining("explicitly retry as a new Bot run"),
    })
    expect(result.output).toHaveProperty(unavailable ? "snapshotError" : "snapshot")
    await executeWork(f.context, f.run, f.config)
    expect(f.mocks.agent).toHaveBeenCalledTimes(1)
    expect(f.mocks.approval).not.toHaveBeenCalled()
    expect(f.mocks.publish).not.toHaveBeenCalled()
  }
)

it("diagnoses external check failures even when no Actions workflow failed", async () => {
  const f = fixture("repair")
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.request.mockImplementation((binding, url) => {
    if (url.includes("/actions/runs?"))
      return Promise.resolve({ status: 200, headers: {}, data: { workflow_runs: [] } })
    if (url.includes("/check-runs"))
      return Promise.resolve({
        status: 200,
        headers: {},
        data: {
          check_runs: [
            {
              id: 55,
              head_sha: SHA,
              name: "External CI",
              conclusion: "failure",
              status: "completed",
              output: { summary: "External validation failed" },
            },
          ],
        },
      })
    return normal(binding, url)
  })
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("published")
  expect(f.mocks.agent).toHaveBeenCalledWith(
    "devin",
    expect.stringContaining("External validation failed"),
    expect.anything()
  )
})
