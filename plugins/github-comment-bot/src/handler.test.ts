import { GithubRequestError } from "@cognia/github-bot-kit"

import { AUTHOR, fixture, issueComment, NOW, REPOSITORY } from "./comment-bot.test-helpers"
import { handleCommandRun, receiveCommands } from "./handler"

it("routes a webhook comment to receiving", async () => {
  const f = fixture({
    triggerId: "github",
    source: "integration",
    type: "issue_comment.created",
    payload: {
      repository: { id: 4242, full_name: REPOSITORY },
      sender: AUTHOR,
      issue: { number: 7 },
      comment: issueComment(11, "@cognia-bot ask why"),
    },
  })
  await expect(handleCommandRun(f.context, f.run, f.now)).resolves.toMatchObject({
    output: { ingress: "webhook", counts: { queued: 1 } },
  })
})

it("polls when due, moves its cursor only after success, and reports polling-only ingress", async () => {
  const f = fixture({ triggerId: "poll", source: "schedule" as never })
  f.github.comments.set(11, issueComment(11, "@cognia-bot ask why"))
  await expect(receiveCommands(f.context, f.run, f.config, f.now)).resolves.toMatchObject({
    output: { ingress: "polling_only", counts: { queued: 1 } },
  })
  expect(f.mocks.recordMonitor).toHaveBeenCalledWith("run", {
    lastSuccessAt: NOW,
    cursor: expect.stringContaining('"ingress":"polling_only"'),
  })
  // Not due yet.
  await expect(
    receiveCommands(f.context, f.run, f.config, () => NOW + 10_000)
  ).resolves.toMatchObject({
    summary: "Waiting for the next scan",
  })
  // With webhooks the poll is a five-minute safety net.
  f.mocks.getInstallation.mockResolvedValue({
    ...(await f.mocks.getInstallation()),
    webhookEnabled: true,
  })
  await expect(
    receiveCommands(f.context, f.run, f.config, () => NOW + 120_000)
  ).resolves.toMatchObject({
    summary: "Waiting for the next scan",
  })
  await expect(
    receiveCommands(f.context, f.run, f.config, () => NOW + 300_000)
  ).resolves.toMatchObject({
    output: { ingress: "webhook_ready" },
  })
})

it("backs off on a rate limit and records the error", async () => {
  const f = fixture({ triggerId: "poll", source: "schedule" as never })
  const route = f.mocks.request.getMockImplementation()!
  f.mocks.request.mockImplementation(async (binding, url, init) => {
    if (url.includes("/issues/comments")) throw new GithubRequestError(403, NOW + 60_000, true)
    return route(binding, url, init)
  })
  await expect(receiveCommands(f.context, f.run, f.config, f.now)).rejects.toThrow("403")
  expect(f.mocks.recordMonitor).toHaveBeenCalledWith(
    "run",
    expect.objectContaining({ retryAt: NOW + 60_000 })
  )
  await expect(
    receiveCommands(f.context, f.run, f.config, () => NOW + 1000)
  ).resolves.toMatchObject({
    summary: "GitHub rate-limit backoff",
  })
})

it("ends as needs_setup with a stable code instead of failing", async () => {
  const f = fixture({ triggerId: "poll", config: { allowedAuthorIds: [] } })
  await expect(handleCommandRun(f.context, f.run, f.now)).resolves.toEqual({
    summary: "Needs setup",
    output: { status: "needs_setup", reasonCode: "allowlist_empty", message: expect.any(String) },
  })
  expect(f.mocks.recordMonitor).toHaveBeenCalledWith("run", {
    lastError: expect.stringMatching(/^allowlist_empty: /),
  })
  const token = fixture({ triggerId: "poll" })
  token.github.viewer = { id: 1, login: "maintainer" }
  await expect(handleCommandRun(token.context, token.run, token.now)).resolves.toMatchObject({
    output: { status: "needs_setup", reasonCode: "trigger_required" },
  })
})

it("routes execute and reply runs, and stops when cancelled", async () => {
  const f = fixture({ triggerId: "reply", payload: { schemaVersion: 2 } })
  await expect(handleCommandRun(f.context, f.run, f.now)).rejects.toThrow("Invalid control reply")
  const e = fixture({ triggerId: "execute", payload: {} })
  await expect(handleCommandRun(e.context, e.run, e.now)).rejects.toThrow("Invalid or out-of-scope")
  const c = fixture({ triggerId: "execute" })
  const aborted = new AbortController()
  aborted.abort()
  c.run.signal = aborted.signal
  await expect(handleCommandRun(c.context, c.run, c.now)).rejects.toThrow()
})

it("checks setup end to end and records blocking problems in the monitor", async () => {
  const ready = fixture({ triggerId: "check" })
  await expect(handleCommandRun(ready.context, ready.run, ready.now)).resolves.toMatchObject({
    summary: "Ready (polling_only)",
    output: { status: "ready", trigger: "@cognia-bot", problems: [] },
  })
  expect(ready.mocks.recordMonitor).toHaveBeenCalledWith("run", { lastSuccessAt: NOW })

  const broken = fixture({ triggerId: "check" })
  broken.mocks.health.mockResolvedValue({
    health: "degraded",
    message: "suspended",
    checkedAt: "t",
  } as never)
  broken.mocks.getInstallation.mockResolvedValue({
    id: "install",
    createdAt: NOW - 1000,
    webhookEnabled: false,
    config: {},
    triggerState: {},
    triggers: [],
    readiness: { policyDecisions: false },
  } as never)
  await expect(handleCommandRun(broken.context, broken.run, broken.now)).resolves.toMatchObject({
    summary: "Needs setup: no_ingress, permission_probe_failed",
    output: { status: "needs_setup" },
  })
  expect(broken.mocks.recordMonitor).toHaveBeenCalledWith("run", {
    lastError: expect.stringContaining("permission_probe_failed: suspended"),
  })
})

it("refuses a second installation answering the same trigger in the same repository", async () => {
  const first = fixture({ triggerId: "poll", source: "schedule" as never })
  await receiveCommands(first.context, first.run, first.config, first.now)
  // Same host storage, another installation.
  const second = fixture({ triggerId: "poll", source: "schedule" as never })
  ;(second.context as { storage: unknown }).storage = first.context.storage
  second.run.installationId = "other"
  await expect(handleCommandRun(second.context, second.run, second.now)).resolves.toMatchObject({
    output: { status: "needs_setup", reasonCode: "trigger_conflict" },
  })
})
