import { GithubRequestError, githubReader, parseWork, workId } from "./github"
import { fixture, NOW } from "./test-fixtures"

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
