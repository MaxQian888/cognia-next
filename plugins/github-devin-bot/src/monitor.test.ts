import { monitor } from "./monitor"
import { fixture, issue, NOW, pr, SHA } from "./test-fixtures"

function polling(mode: "implement" | "review" | "repair" = "implement") {
  const f = fixture(mode)
  f.run.event.triggerId = "poll"
  f.run.event.source = "schedule"
  return f
}
it("queues new issues without invoking Devin or waiting for approval", async () => {
  const f = polling()
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.enqueue).toHaveBeenCalledWith(
    "run",
    expect.objectContaining({
      triggerId: "work",
      eventId: expect.stringContaining("issue/7/implement/"),
      payload: expect.objectContaining({ repository: f.config.repository }),
    })
  )
  expect(f.mocks.agent).not.toHaveBeenCalled()
  expect(f.mocks.approval).not.toHaveBeenCalled()
  expect(f.mocks.recordMonitor).toHaveBeenCalledWith(
    "run",
    expect.objectContaining({ lastSuccessAt: NOW })
  )
})
it("does not execute the historical backlog", async () => {
  const f = polling()
  f.item.created_at = new Date(NOW - 60_000).toISOString()
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.enqueue).not.toHaveBeenCalled()
})
it("promotes a pre-arming manual scan cursor to the activation watermark", async () => {
  const f = polling()
  const previousWatermark = NOW - 120_000
  f.memory.set(`monitor:v1:install:${f.config.repository.toLowerCase()}`, {
    version: 1,
    watermark: previousWatermark,
    since: new Date(previousWatermark).toISOString(),
    pulls: [],
  })
  f.item.created_at = new Date(NOW - 60_000).toISOString()
  f.mocks.getInstallation.mockResolvedValue({
    id: "install",
    createdAt: previousWatermark,
    activatedAt: NOW,
    webhookEnabled: false,
    config: {},
    triggerState: {},
  })
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.enqueue).not.toHaveBeenCalled()
  expect(f.memory.get(`monitor:v1:install:${f.config.repository.toLowerCase()}`)).toMatchObject({
    watermark: NOW,
    since: new Date(NOW).toISOString(),
  })
  expect(f.mocks.request).toHaveBeenCalledWith(
    expect.anything(),
    expect.stringContaining(`since=${encodeURIComponent(new Date(NOW).toISOString())}`),
    expect.anything()
  )
})
it("backfills only explicitly selected item numbers, including form text", async () => {
  const f = polling()
  f.item.created_at = new Date(NOW - 60_000).toISOString()
  f.run.event.triggerId = "backfill"
  f.run.event.payload = { numbers: "7" }
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.enqueue).toHaveBeenCalledTimes(1)
  f.run.event.payload = { numbers: "7,0" }
  await expect(monitor(f.context, f.run, f.config, () => NOW)).rejects.toThrow("Backfill requires")
})
it("cancels closed resources and skips draft PRs", async () => {
  const f = polling()
  f.item.state = "closed"
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.cancelResource).toHaveBeenCalledWith("run", {
    resourceId: expect.stringContaining("#7"),
  })
  const draft = polling("review")
  draft.item.draft = true
  await monitor(draft.context, draft.run, draft.config, () => NOW)
  expect(draft.mocks.enqueue).not.toHaveBeenCalled()
})
it("continues inspecting cached heads for CI when PR listing returns 304", async () => {
  const f = polling("repair")
  f.memory.set(`monitor:v1:install:${f.config.repository.toLowerCase()}`, {
    version: 1,
    watermark: NOW - 1000,
    since: issue.created_at,
    pulls: [pr],
    pullsEtag: "old",
  })
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.request.mockImplementation((binding, url) =>
    url.includes("/pulls?")
      ? Promise.resolve({ status: 304, headers: {}, data: undefined })
      : normal(binding, url)
  )
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.enqueue).toHaveBeenCalledWith(
    "run",
    expect.objectContaining({ payload: expect.objectContaining({ mode: "repair", revision: SHA }) })
  )
})
it("keeps cursor unchanged on request failure and records a visible sync error", async () => {
  const f = polling()
  f.mocks.request.mockResolvedValue({ status: 429, headers: { "Retry-After": "10" }, data: {} })
  await expect(monitor(f.context, f.run, f.config, () => NOW)).rejects.toThrow("429")
  expect(f.mocks.recordMonitor).toHaveBeenLastCalledWith(
    "run",
    expect.objectContaining({ lastError: expect.stringContaining("429"), retryAt: NOW + 10_000 })
  )
  f.mocks.request.mockClear()
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.request).not.toHaveBeenCalled()
})
it("clears synchronization failure and backoff after the next successful read", async () => {
  const f = polling()
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.request.mockResolvedValue({ status: 429, headers: { "Retry-After": "10" }, data: {} })
  await expect(monitor(f.context, f.run, f.config, () => NOW)).rejects.toThrow("429")
  f.memo.clear()
  f.mocks.request.mockImplementation(normal)
  await monitor(f.context, f.run, f.config, () => NOW + 20_000)
  expect(f.mocks.recordMonitor).toHaveBeenLastCalledWith("run", {
    lastSuccessAt: NOW + 20_000,
    lastError: undefined,
    retryAt: undefined,
    cursor: expect.any(String),
  })
  expect(
    f.memory.get(`monitor:v1:install:${f.config.repository.toLowerCase()}`)
  ).not.toHaveProperty("retryAt")
})
it("webhook and poll deliveries converge on the same work identity", async () => {
  const a = polling()
  await monitor(a.context, a.run, a.config, () => NOW)
  const b = polling()
  b.run.event.source = "integration"
  b.run.event.payload = { repository: { full_name: b.config.repository }, issue }
  await monitor(b.context, b.run, b.config, () => NOW)
  expect(b.mocks.enqueue.mock.calls[0]).toEqual(a.mocks.enqueue.mock.calls[0])
})
it("does not dispatch events from another repository or its own provenance", async () => {
  for (const selfProduced of [false, true]) {
    const f = polling()
    f.run.event.source = "integration"
    f.run.event.provenance.selfProduced = selfProduced
    f.run.event.payload = { repository: { full_name: "other/repo" }, issue }
    await monitor(f.context, f.run, f.config, () => NOW)
    expect(f.mocks.enqueue).not.toHaveBeenCalled()
  }
})

it("reduces webhook reconciliation frequency and avoids duplicate scans", async () => {
  const f = polling()
  f.mocks.getInstallation.mockResolvedValue({
    id: "install",
    createdAt: NOW,
    activatedAt: NOW,
    webhookEnabled: true,
    config: {},
    triggerState: {},
  })
  f.memory.set(`monitor:v1:install:${f.config.repository.toLowerCase()}`, {
    version: 1,
    watermark: NOW,
    since: issue.created_at,
    pulls: [],
    lastScanAt: NOW - 120_000,
  })
  expect((await monitor(f.context, f.run, f.config, () => NOW)).summary).toContain(
    "next reconciliation"
  )
  expect(f.mocks.request).not.toHaveBeenCalled()
})
it.each(["pull_request", "check_run", "workflow_run", "unknown"])(
  "normalizes webhook payload %s",
  async (field) => {
    const f = polling("review")
    f.run.event.source = "integration"
    f.run.event.payload = {
      repository: { full_name: f.config.repository },
      [field]: field === "pull_request" ? pr : { pull_requests: [{ number: pr.number }] },
    }
    await monitor(f.context, f.run, f.config, () => NOW)
    expect(f.mocks.enqueue).toHaveBeenCalledTimes(field === "unknown" ? 0 : 1)
  }
)
it("does not recursively review its own PR and stops bounded follow-up repairs", async () => {
  for (const attempts of [0, 2]) {
    const f = polling("repair")
    f.item.body = "<!-- cognia-github-devin:owned -->"
    f.memory.set(`published:v1:install:${f.config.repository.toLowerCase()}:8`, { attempts })
    await monitor(f.context, f.run, f.config, () => NOW)
    expect(f.mocks.enqueue).toHaveBeenCalledTimes(attempts === 0 ? 1 : 0)
  }
})
it("rejects empty backfill and exposes non-HTTP synchronization failures", async () => {
  const f = polling()
  f.run.event.triggerId = "backfill"
  f.run.event.payload = null
  await expect(monitor(f.context, f.run, f.config, () => NOW)).rejects.toThrow("Backfill requires")
  f.run.event.triggerId = "poll"
  f.mocks.request.mockRejectedValue("offline")
  await expect(monitor(f.context, f.run, f.config, () => NOW)).rejects.toBe("offline")
  expect(f.mocks.recordMonitor).toHaveBeenLastCalledWith(
    "run",
    expect.objectContaining({ lastError: "offline" })
  )
})

it("does not report previously dispatched work as newly queued", async () => {
  const f = polling()
  await monitor(f.context, f.run, f.config, () => NOW)
  f.memo.clear()
  const result = await monitor(f.context, f.run, f.config, () => NOW + 60_000)
  expect(f.mocks.enqueue).toHaveBeenCalledTimes(1)
  expect(result.summary).toContain("no actionable changes")
})

it("repairs failed external checks and cancels obsolete head work", async () => {
  const f = polling("review")
  const normal = f.mocks.request.getMockImplementation()!
  f.mocks.request.mockImplementation((binding, url) =>
    url.includes("/check-runs")
      ? Promise.resolve({
          status: 200,
          headers: {},
          data: {
            check_runs: [
              {
                id: 10,
                head_sha: SHA,
                name: "external CI",
                conclusion: "failure",
                status: "completed",
              },
            ],
          },
        })
      : normal(binding, url)
  )
  await monitor(f.context, f.run, f.config, () => NOW)
  expect(f.mocks.enqueue).toHaveBeenCalledWith(
    "run",
    expect.objectContaining({ payload: expect.objectContaining({ mode: "repair" }) })
  )
  expect(f.mocks.cancelResource).toHaveBeenCalledWith("run", {
    resourceId: expect.stringContaining("#8"),
    exceptRevision: SHA,
  })
})
