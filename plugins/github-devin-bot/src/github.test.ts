import {
  GithubRequestError,
  githubReader,
  parseWork,
  workId,
  currentCiFailures,
  currentCiExecutions,
} from "./github"
import { fixture, NOW, SHA } from "./devin-bot.test-helpers"

it("selects only current-SHA latest attempts while preserving genuinely pending checks", () => {
  const run = { id: 1, workflow_id: 9, head_sha: SHA, status: "in_progress", conclusion: null }
  const check = {
    id: 1,
    app: { id: 9 },
    name: "test",
    head_sha: SHA,
    status: "in_progress",
    conclusion: null,
  }
  const executions = currentCiExecutions(
    [
      { ...run, run_attempt: 1 },
      { ...run, run_attempt: 2, status: "completed", conclusion: "success" },
      { ...run, id: 2, head_sha: "old" },
    ],
    [
      check,
      { ...check, id: 2, status: "completed", conclusion: "success" },
      { ...check, id: 3, name: "lint", status: "queued" },
      { ...check, id: 4, head_sha: "old" },
    ],
    SHA
  )
  expect(executions).toMatchObject({
    workflows: [{ id: 1, run_attempt: 2, status: "completed" }],
    checks: [
      { id: 3, name: "lint", status: "queued" },
      { id: 2, status: "completed" },
    ],
  })
})

it("ignores old CI failures after successful or pending reruns and keeps distinct checks", () => {
  const run = { id: 1, workflow_id: 9, head_sha: SHA, status: "completed", conclusion: "failure" }
  const check = {
    id: 1,
    app: { id: 8 },
    name: "test",
    head_sha: SHA,
    status: "completed",
    conclusion: "failure",
  }
  expect(
    currentCiFailures(
      [
        run,
        { ...run, id: 2, conclusion: "success" },
        { ...run, id: 3, head_sha: "old" },
        { ...run, id: 4, workflow_id: 10, status: "in_progress" },
        { ...run, id: 5, workflow_id: 10 },
        { ...run, id: 6, workflow_id: 11, run_attempt: 1 },
        { ...run, id: 6, workflow_id: 11, run_attempt: 2, conclusion: "success" },
        { ...run, id: 7, workflow_id: undefined, name: "lint" },
        { ...run, id: 8, workflow_id: undefined },
      ],
      [
        check,
        { ...check, id: 2, conclusion: "success" },
        { ...check, id: 3, app: { id: 9 } },
        { ...check, id: 4, head_sha: "old" },
        { ...check, id: 5, name: "lint", status: "queued" },
        { ...check, id: 6, name: "external", app: undefined },
      ],
      SHA
    )
  ).toMatchObject({ workflows: [{ id: 8 }, { id: 7 }, { id: 5 }], checks: [{ id: 6 }, { id: 3 }] })
})

it("passes the opaque run binding, never an account token", async () => {
  const f = fixture()
  await githubReader(f.context, "run", f.config.repository).request("/issues/7", "etag")
  expect(f.mocks.request).toHaveBeenCalledWith(
    { runId: "run", slotId: "github" },
    expect.any(String),
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ "If-None-Match": "etag" }),
    })
  )
})
it("paginates using Link and does not mistake a full final page for more data", async () => {
  const f = fixture()
  f.mocks.request
    .mockResolvedValueOnce({ status: 200, headers: { Link: '<page2>; rel="next"' }, data: [1] })
    .mockResolvedValueOnce({ status: 200, headers: {}, data: [2] })
  expect(await githubReader(f.context, "run", f.config.repository).pages("/issues")).toEqual([1, 2])
  expect(f.mocks.request.mock.calls[1][1]).toContain("page=2")
})
it("exposes rate-limit backoff without leaking response bodies", async () => {
  const f = fixture()
  f.mocks.request.mockResolvedValue({
    status: 429,
    headers: { "Retry-After": "120" },
    data: "secret",
  })
  await expect(
    githubReader(f.context, "run", f.config.repository, () => NOW).request("/issues")
  ).rejects.toMatchObject({ status: 429, retryAt: NOW + 120_000 })
  expect(new GithubRequestError(500).message).not.toContain("secret")
})
it("rejects cross-repository work and malformed collections", async () => {
  const f = fixture()
  expect(() => parseWork({ ...f.work, repository: "attacker/repo" }, f.config.repository)).toThrow(
    "out-of-scope"
  )
  f.mocks.request.mockResolvedValue({ status: 200, headers: {}, data: {} })
  await expect(
    githubReader(f.context, "run", f.config.repository).pages("/issues")
  ).rejects.toThrow("Invalid GitHub")
})
it("deduplicates CI job deliveries by item mode and head", () => {
  const f = fixture("repair")
  expect(workId({ ...f.work, workflowRunId: 1 })).toEqual(workId({ ...f.work, workflowRunId: 2 }))
})

it.each([
  [403, { "x-ratelimit-reset": String((NOW + 60_000) / 1000) }, NOW + 60_000],
  [403, {}, NOW + 60_000],
  [500, {}, undefined],
])("uses reset/backoff for status %s", async (status, headers, retryAt) => {
  const f = fixture()
  f.mocks.request.mockResolvedValue({
    status: status as number,
    headers: headers as Record<string, string>,
    data: {},
  })
  await expect(
    githubReader(f.context, "run", f.config.repository, () => NOW).request("/issues")
  ).rejects.toMatchObject({ status, retryAt })
})
it("rejects nonrelative paths and accepts HTTP 304 without a response body", async () => {
  const f = fixture()
  const api = githubReader(f.context, "run", f.config.repository)
  await expect(api.request("https://other.example/path")).rejects.toThrow("repository-relative")
  f.mocks.request.mockResolvedValue({ status: 304, headers: {}, data: undefined })
  expect((await api.request("/issues", "etag")).status).toBe(304)
})
it.each([null, {}, { number: 0 }, { kind: "invalid" }, { mode: "repair" }, { revision: "" }])(
  "validates untrusted work %j",
  (patch) => {
    const f = fixture()
    expect(() =>
      parseWork(
        patch && Object.keys(patch).length ? { ...f.work, ...patch } : patch,
        f.config.repository
      )
    ).toThrow()
  }
)
