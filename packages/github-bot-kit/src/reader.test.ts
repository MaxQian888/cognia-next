import { GithubRequestError, githubReader, type GithubReadTransport } from "./reader"

const NOW = Date.parse("2026-09-12T10:00:00Z")
const BINDING = { runId: "run", slotId: "github" }

function reader(now?: () => number) {
  const request = jest.fn(async (..._args: unknown[]) => ({
    status: 200,
    headers: {} as Record<string, string>,
    data: [] as unknown,
  }))
  const ctx = { integrations: { authenticatedRequest: request } } as unknown as GithubReadTransport
  return { request, api: githubReader(ctx, BINDING, "acme/widgets", now) }
}

it("passes the opaque run binding, never an account token", async () => {
  const { request, api } = reader()
  await api.request("/issues/7", "etag")
  expect(request).toHaveBeenCalledWith(
    { runId: "run", slotId: "github" },
    "/repos/acme/widgets/issues/7",
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ "If-None-Match": "etag" }),
    })
  )
})

it("binds to whichever slot the Bot declares", async () => {
  const request = jest.fn(async () => ({ status: 200, headers: {}, data: {} }))
  const ctx = { integrations: { authenticatedRequest: request } } as unknown as GithubReadTransport
  await githubReader(ctx, { runId: "r", slotId: "repo" }, "acme/widgets").request("")
  expect(request).toHaveBeenCalledWith(
    { runId: "r", slotId: "repo" },
    "/repos/acme/widgets",
    expect.anything()
  )
})

it("paginates using Link and does not mistake a full final page for more data", async () => {
  const { request, api } = reader()
  request
    .mockResolvedValueOnce({ status: 200, headers: { Link: '<page2>; rel="next"' }, data: [1] })
    .mockResolvedValueOnce({ status: 200, headers: {}, data: [2] })
  expect(await api.pages("/issues")).toEqual([1, 2])
  expect(request.mock.calls[1][1]).toContain("page=2")
})

it("stops a bounded page window and says it was cut", async () => {
  const { request, api } = reader()
  request.mockResolvedValue({ status: 200, headers: { link: '<n>; rel="next"' }, data: [1] })
  expect(await api.pageWindow("/issues?state=open", { maxPages: 2 })).toEqual({
    items: [1, 1],
    truncated: true,
  })
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[0][1]).toBe("/repos/acme/widgets/issues?state=open&per_page=100&page=1")
  request.mockReset()
  request.mockResolvedValue({ status: 200, headers: {}, data: { workflow_runs: [3] } })
  expect(await api.pageWindow("/actions/runs", { field: "workflow_runs", maxPages: 1 })).toEqual({
    items: [3],
    truncated: false,
  })
})

it("exposes rate-limit backoff without leaking response bodies", async () => {
  const { request, api } = reader(() => NOW)
  request.mockResolvedValue({ status: 429, headers: { "Retry-After": "120" }, data: "secret" })
  await expect(api.request("/issues")).rejects.toMatchObject({
    status: 429,
    retryAt: NOW + 120_000,
    rateLimited: true,
  })
  expect(new GithubRequestError(500).message).not.toContain("secret")
})

it("rejects malformed collections", async () => {
  const { request, api } = reader()
  request.mockResolvedValue({ status: 200, headers: {}, data: {} })
  await expect(api.pages("/issues")).rejects.toThrow("Invalid GitHub")
})

it.each([
  [
    403,
    { "x-ratelimit-reset": String((NOW + 60_000) / 1000), "x-ratelimit-remaining": "0" },
    NOW + 60_000,
    true,
  ],
  [403, { "retry-after": "5" }, NOW + 5_000, true],
  // A plain 403 is a refusal; it keeps the old backoff hint but is not a rate limit.
  [403, {}, NOW + 60_000, false],
  [500, {}, undefined, false],
])("uses reset/backoff for status %s", async (status, headers, retryAt, rateLimited) => {
  const { request, api } = reader(() => NOW)
  request.mockResolvedValue({ status, headers: headers as Record<string, string>, data: {} })
  await expect(api.request("/issues")).rejects.toMatchObject({ status, retryAt, rateLimited })
})

it("rejects nonrelative paths and accepts HTTP 304 without a response body", async () => {
  const { request, api } = reader()
  await expect(api.request("https://other.example/path")).rejects.toThrow("repository-relative")
  request.mockResolvedValue({ status: 304, headers: {}, data: undefined })
  expect((await api.request("/issues", "etag")).status).toBe(304)
})

it("reads the viewer and items outside and inside the repository prefix", async () => {
  const { request, api } = reader()
  request.mockResolvedValueOnce({ status: 200, headers: {}, data: { id: 1, login: "me" } })
  expect(await api.viewer()).toEqual({ id: 1, login: "me" })
  expect(request.mock.calls[0][1]).toBe("/user")
  request.mockResolvedValue({ status: 200, headers: {}, data: { number: 8 } })
  await api.item(8, "pr")
  await api.item(7, "issue")
  expect(request.mock.calls[1][1]).toBe("/repos/acme/widgets/pulls/8")
  expect(request.mock.calls[2][1]).toBe("/repos/acme/widgets/issues/7")
})
