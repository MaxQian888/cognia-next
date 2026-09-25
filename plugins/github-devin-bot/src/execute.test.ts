import { executeWork, parseReport } from "./execute"
import { fixture, SHA } from "./devin-bot.test-helpers"
import { monitor } from "./monitor"

it("reuses the live issue #25 report without requiring an unused review field", async () => {
  const f = fixture()
  // Minimal live result shape: the implementation reported 40 passing tests
  // and omitted the PR-only review field. No session messages are copied.
  const report = {
    summary:
      "Added parameterized boundary tests to lib/__tests__/navigation.test.ts per issue #25.",
    changesNeeded: true,
    tests: [
      {
        command: "pnpm test --runInBand lib/__tests__/navigation.test.ts",
        exitCode: 0,
        output: "Test Suites: 1 passed, 1 total\nTests: 40 passed, 40 total",
      },
    ],
  }
  const text = `Implemented the requested boundary tests.\n\n\u0060\u0060\u0060json\n${JSON.stringify(report)}\n\u0060\u0060\u0060`
  f.memo.set("devin-1", {
    sessionId: "recorded-session",
    agentId: "devin",
    model: f.config.model,
    status: "completed",
    text,
    toolCalls: [],
  })
  const result = await executeWork(f.context, f.run, f.config)
  expect(result.output.status).toBe("published")
  expect(result.output).toMatchObject({ report: { ...report, review: "" } })
  expect(f.mocks.agent).not.toHaveBeenCalled()
})

it.each(["implement", "repair"] as const)(
  "accepts omitted review only for %s without weakening other validation",
  (mode) => {
    const { review: _review, ...report } = fixture().report
    expect(parseReport(JSON.stringify(report), mode)).toEqual({ ...report, review: "" })
    for (const patch of [
      { review: null },
      { review: 42 },
      { review: {} },
      { changesNeeded: "true" },
      { tests: null },
      { tests: [{ command: "test", exitCode: "0", output: "passed" }] },
    ])
      expect(() => parseReport(JSON.stringify({ ...report, ...patch }), mode)).toThrow()
    const raw = JSON.stringify(report)
    for (const text of [`${raw}\n${raw}`, `[${raw}]`, `Result: [${raw}]`, "not json"])
      expect(() => parseReport(text, mode)).toThrow()
    expect(parseReport(JSON.stringify({ ...report, tests: [] }), mode).tests).toEqual([])
    expect(
      parseReport(
        JSON.stringify({ ...report, tests: [{ command: "test", exitCode: 1, output: "failed" }] }),
        mode
      ).tests[0].exitCode
    ).toBe(1)
  }
)

it.each([undefined, "", " ", null, 1])(
  "requires actual review content for review tasks: %j",
  (review) => {
    expect(() => parseReport(JSON.stringify({ ...fixture().report, review }), "review")).toThrow()
  }
)

it.each([
  ["approval", "approval", "acceptEdits", "human"],
  ["unattended", "approval", "bypassPermissions", "human"],
  ["approval", "automatic", "acceptEdits", "policy"],
  ["unattended", "automatic", "bypassPermissions", "policy"],
] as const)(
  "keeps execution %s separate from publication %s",
  async (executionMode, publicationMode, permissionMode, decisionMode) => {
    const f = fixture()
    await executeWork(f.context, f.run, { ...f.config, executionMode, publicationMode })
    expect(f.mocks.agent).toHaveBeenCalledWith(
      "devin",
      expect.any(String),
      expect.objectContaining({ permissionMode })
    )
    expect(f.mocks.approval).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({ decisionMode })
    )
  }
)

it.each([
  ["comment", "COMMENT", true],
  ["request_changes", "REQUEST_CHANGES", true],
  ["approve", "APPROVE", false],
] as const)(
  "publishes exact structured %s verdict and findings",
  async (verdict, event, changesNeeded) => {
    const f = fixture("review")
    f.item.user = { id: 2, login: "contributor" }
    const normal = f.mocks.request.getMockImplementation()!
    f.mocks.request.mockImplementation((binding, url) =>
      url.endsWith("/user")
        ? Promise.resolve({ status: 200, headers: {}, data: { id: 1, login: "reviewer" } })
        : normal(binding, url)
    )
    const findings = changesNeeded
      ? [{ path: "src/file.ts", line: 3, side: "RIGHT", body: "Null input crashes here." }]
      : []
    f.mocks.agent.mockResolvedValue({
      ...(await f.mocks.agent()),
      text: JSON.stringify({ ...f.report, verdict, findings, changesNeeded }),
    })
    await executeWork(f.context, f.run, f.config)
    expect(f.mocks.action).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          event,
          commitId: SHA,
          ...(findings.length ? { comments: findings } : {}),
        }),
      })
    )
    expect(f.mocks.publish).not.toHaveBeenCalled()
    expect(f.mocks.approval).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({ title: "Publish this GitHub review?" })
    )
  }
)

it.each([
  ["approve", "same-author"],
  ["approve", "unknown-author"],
  ["approve", "unavailable-actor"],
  ["request_changes", "same-author"],
  ["request_changes", "unknown-author"],
  ["request_changes", "unavailable-actor"],
] as const)("publishes a comment instead of %s for %s", async (verdict, reason) => {
  const f = fixture("review")
  if (reason === "same-author") f.item.user = { id: 1, login: "owner" }
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.request.mockImplementation((binding, url) =>
    url.endsWith("/user")
      ? Promise.resolve({
          status: reason === "unavailable-actor" ? 403 : 200,
          headers: {},
          data: { id: 1, login: "owner" },
        })
      : normal(binding, url)
  )
  const findings =
    verdict === "request_changes"
      ? [{ path: "src/file.ts", line: 3, side: "RIGHT", body: "Null input crashes here." }]
      : []
  f.mocks.agent.mockResolvedValue({
    ...(await f.mocks.agent()),
    text: JSON.stringify({
      ...f.report,
      changesNeeded: verdict === "request_changes",
      verdict,
      findings,
    }),
  })
  await executeWork(f.context, f.run, f.config)
  expect(f.mocks.action).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        event: "COMMENT",
        body: expect.stringContaining(`${f.report.review}\n\nReview completed as a comment`),
        ...(findings.length ? { comments: findings } : {}),
      }),
    })
  )
})

it.each([
  { verdict: "merge" },
  { verdict: "approve", changesNeeded: true },
  {
    verdict: "approve",
    changesNeeded: false,
    findings: [{ path: "file", line: 1, side: "RIGHT", body: "bug" }],
  },
  { findings: [{ path: "../private", line: 1, side: "RIGHT", body: "bug" }] },
  { findings: [{ path: "file", line: 0, side: "RIGHT", body: "bug" }] },
  { findings: [{ path: "file", line: 1, side: "TOP", body: "bug" }] },
  { findings: [{ path: "file", line: 1, side: "RIGHT", body: "" }] },
])("rejects malformed or contradictory review detail %j", (patch) => {
  expect(() => parseReport(JSON.stringify({ ...fixture().report, ...patch }))).toThrow()
})

it("skips a previously published exact PR revision and passes the previous SHA for incremental work", async () => {
  const f = fixture("review")
  const key = `review:v1:install:${f.config.repository.toLowerCase()}:8`
  f.memory.set(key, { sha: SHA })
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("skipped")
  expect(f.mocks.agent).not.toHaveBeenCalled()
  f.memo.clear()
  f.memory.set(key, { sha: "b".repeat(40) })
  await executeWork(f.context, f.run, f.config)
  expect(f.mocks.agent).toHaveBeenCalledWith(
    "devin",
    expect.stringContaining(`"previousReviewSha":"${"b".repeat(40)}"`),
    expect.anything()
  )
})

it.each(["diverged", "missing", "offline"])(
  "handles previous review ancestry %s without pretending incremental coverage",
  async (mode) => {
    const f = fixture("review")
    f.memory.set(`review:v1:install:${f.config.repository.toLowerCase()}:8`, {
      sha: "b".repeat(40),
    })
    const normal = f.mocks.request.getMockImplementation()!
    f.mocks.request.mockImplementation((binding, url) =>
      url.includes("/compare/")
        ? Promise.resolve({
            status: mode === "missing" ? 404 : mode === "offline" ? 503 : 200,
            headers: {},
            data: { status: "diverged", merge_base_commit: { sha: "c".repeat(40) } },
          })
        : normal(binding, url)
    )
    if (mode === "offline")
      await expect(executeWork(f.context, f.run, f.config)).rejects.toThrow("503")
    else {
      await executeWork(f.context, f.run, f.config)
      expect((f.mocks.agent.mock.calls[0] as unknown as [string, string])[1]).not.toContain(
        '"previousReviewSha":'
      )
    }
  }
)

it("retains a CI patch when a successful rerun supersedes the approved diagnosis", async () => {
  const f = fixture("repair")
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.approval.mockImplementation(async () => {
    f.mocks.request.mockImplementation((binding, url) =>
      url.includes("/actions/runs?")
        ? Promise.resolve({ status: 200, headers: {}, data: { workflow_runs: [] } })
        : normal(binding, url)
    )
    return { outcome: "approved", decidedAt: 1, approvalId: "approval" }
  })
  expect((await executeWork(f.context, f.run, f.config)).output.status).toBe("stale")
  expect(f.mocks.publish).not.toHaveBeenCalled()
  expect(f.mocks.action).not.toHaveBeenCalled()
})

it("publishes only the exact approved patch and PR content", async () => {
  const f = fixture()
  const result = await executeWork(f.context, f.run, f.config)
  expect(result.output.status).toBe("published")
  expect(f.mocks.publish).toHaveBeenCalledWith(expect.anything(), {
    approvalId: "approval",
    snapshotId: "snapshot",
    message: "fix: resolve issue #7",
    branch: expect.stringMatching(/^cognia\/github-devin\/issue-7-/),
  })
  expect(f.mocks.approval).toHaveBeenCalledWith(
    "publish",
    expect.objectContaining({
      title: "Publish this patch and open a pull request?",
      message: expect.stringContaining("no automatic merge is performed"),
    })
  )
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
it("delegates uncertain review recovery to the broker for exact verdict and inline validation", async () => {
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
  expect(f.mocks.action).toHaveBeenCalledTimes(1)
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
it("parses one complete report wrapped in prose or a JSON fence without inventing tests", () => {
  const report = {
    summary: "Read-only tools prevented edits or test execution",
    review: "Proposed patch only",
    changesNeeded: true,
    tests: [],
  }
  for (const text of [
    `I inspected the existing test file.\n\n\u0060\u0060\u0060json\n${JSON.stringify(report)}\n\u0060\u0060\u0060`,
    `The result follows.\n${JSON.stringify(report)}\nPlease inspect the retained workspace.`,
  ])
    expect(parseReport(text)).toEqual(report)
  const escaped = {
    ...report,
    review: 'Keep braces { } and escaped quotes " in the proposed comment.',
  }
  expect(parseReport(`Result: ${JSON.stringify(escaped)}`)).toEqual(escaped)
})
it("rejects ambiguous multiple reports and array wrappers", () => {
  const report = JSON.stringify(fixture().report)
  for (const text of [
    `${report}\n${report}`,
    `[${report}]`,
    `Result: [${report}]`,
    `prefix { broken`,
  ])
    expect(() => parseReport(text)).toThrow()
})
it("reuses the recorded read-only completion and blocks missing evidence after the remaining attempt", async () => {
  const f = fixture()
  // Minimal fixture of the live issue #23 completion: prose + one JSON fence,
  // changes required, no executed commands. Session messages are not copied.
  const report = {
    ...f.report,
    summary: "This session provides read-only tools only (no edit/exec).",
    tests: [],
  }
  const text = `I inspected the existing test file. This environment provides read-only tools only (no edit/exec), so I cannot apply the changes or run tests myself.\n\n\u0060\u0060\u0060json\n${JSON.stringify(report)}\n\u0060\u0060\u0060`
  const completed = {
    sessionId: "recorded-session",
    agentId: "devin",
    model: "swe-2-medium",
    status: "completed" as const,
    text,
    toolCalls: [],
  }
  f.memo.set("devin-1", completed)
  f.mocks.agent.mockResolvedValue(completed)
  const result = await executeWork(f.context, f.run, f.config)
  expect(result.output).toMatchObject({
    status: "blocked",
    sessionId: "recorded-session",
    rawResponse: text,
    report: { tests: [] },
    snapshot: f.snapshot,
  })
  expect(f.mocks.agent).toHaveBeenCalledTimes(1)
  expect(f.mocks.agent).toHaveBeenCalledWith(
    "devin",
    expect.any(String),
    expect.objectContaining({ invocationId: "attempt-2", sessionId: "recorded-session" })
  )
  await executeWork(f.context, f.run, f.config)
  expect(f.mocks.agent).toHaveBeenCalledTimes(1)
  expect(f.mocks.approval).not.toHaveBeenCalled()
  expect(f.mocks.publish).not.toHaveBeenCalled()
})
it.each([false, true])(
  "retains malformed completed output without redispatch or publication (snapshot failed: %s)",
  async (snapshotFailed) => {
    const f = fixture()
    const rawText = "I inspected the repository but did not return a structured report."
    f.mocks.agent.mockResolvedValue({
      sessionId: "completed-session",
      agentId: "devin",
      model: "swe-2-medium",
      status: "completed",
      text: rawText,
      toolCalls: [],
    })
    if (snapshotFailed) f.mocks.snapshot.mockRejectedValue(new Error("Snapshot unavailable"))
    const result = await executeWork(f.context, f.run, f.config)
    expect(result.output).toMatchObject({
      status: "blocked",
      reasonCode: "invalid_result_report",
      sessionId: "completed-session",
      model: "swe-2-medium",
      report: { rawText, toolCalls: [] },
      guidance: expect.stringContaining("Inspect"),
    })
    expect(result.output).toHaveProperty(snapshotFailed ? "snapshotError" : "snapshot")
    await executeWork(f.context, f.run, f.config)
    expect(f.mocks.agent).toHaveBeenCalledTimes(1)
    expect(f.mocks.snapshot).toHaveBeenCalledTimes(1)
    expect(f.mocks.approval).not.toHaveBeenCalled()
    expect(f.mocks.publish).not.toHaveBeenCalled()
    expect(f.mocks.action).not.toHaveBeenCalled()
  }
)
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
  expect((await executeWork(empty.context, empty.run, empty.config)).output).toMatchObject({
    status: "blocked",
    reasonCode: "invalid_result_report",
  })
  expect(empty.mocks.approval).not.toHaveBeenCalled()
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
