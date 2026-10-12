import { checkCommandAuthor } from "./authorize"
import { GithubRequestError } from "./reader"

const author = { id: 42, login: "octo-cat" }
function reader(result: unknown) {
  const request = jest.fn(async () => {
    if (result instanceof Error) throw result
    return { status: 200, headers: {}, data: result }
  })
  return { request } as unknown as Parameters<typeof checkCommandAuthor>[0] & {
    request: jest.Mock
  }
}

it("allows an allowlisted collaborator with write access, checked by id", async () => {
  const api = reader({
    permission: "write",
    role_name: "write",
    user: { id: 42, login: "octo-cat" },
  })
  expect(await checkCommandAuthor(api, author, ["42"])).toEqual({
    outcome: "allowed",
    permission: "write",
  })
  expect(api.request).toHaveBeenCalledWith("/collaborators/octo-cat/permission")
  expect(
    await checkCommandAuthor(reader({ permission: "admin", user: { id: 42 } }), author, [42])
  ).toEqual({
    outcome: "allowed",
    permission: "admin",
  })
  expect(
    await checkCommandAuthor(
      reader({ permission: "write", role_name: "maintain", user: { id: 42 } }),
      author,
      [42]
    )
  ).toEqual({ outcome: "allowed", permission: "maintain" })
})

it("refuses machine accounts and authors off the allowlist without asking GitHub", async () => {
  const api = reader({ permission: "admin", user: { id: 42 } })
  expect(await checkCommandAuthor(api, { ...author, type: "Bot" }, ["42"])).toEqual({
    outcome: "denied",
    reason: "bot_author",
  })
  expect(await checkCommandAuthor(api, { id: 42, login: "x[bot]" }, ["42"])).toMatchObject({
    reason: "bot_author",
  })
  expect(await checkCommandAuthor(api, author, ["7"])).toEqual({
    outcome: "denied",
    reason: "not_allowlisted",
  })
  expect(await checkCommandAuthor(api, author, [])).toMatchObject({ reason: "not_allowlisted" })
  expect(api.request).not.toHaveBeenCalled()
})

it("refuses an identity it cannot trust", async () => {
  expect(await checkCommandAuthor(reader({}), { id: 0, login: "a" }, ["0"])).toMatchObject({
    reason: "identity_mismatch",
  })
  expect(await checkCommandAuthor(reader({}), { id: 42, login: "../x" }, ["42"])).toMatchObject({
    reason: "identity_mismatch",
  })
  // The login now belongs to someone else.
  expect(
    await checkCommandAuthor(reader({ permission: "admin", user: { id: 99 } }), author, ["42"])
  ).toEqual({ outcome: "denied", reason: "identity_mismatch" })
})

it.each([
  ["read", "insufficient_permission"],
  ["triage", "insufficient_permission"],
  ["none", "insufficient_permission"],
  ["superuser", "unknown_permission"],
  [undefined, "unknown_permission"],
])("denies base permission %s", async (permission, reason) => {
  expect(
    await checkCommandAuthor(reader({ permission, user: { id: 42 } }), author, ["42"])
  ).toEqual({
    outcome: "denied",
    reason,
  })
})

it("treats a failure to ask as unavailable, never as a verdict on the author", async () => {
  expect(await checkCommandAuthor(reader(new GithubRequestError(404)), author, ["42"])).toEqual({
    outcome: "denied",
    reason: "not_collaborator",
  })
  expect(
    await checkCommandAuthor(reader(new GithubRequestError(429, 1000, true)), author, ["42"])
  ).toEqual({ outcome: "unavailable", reason: "rate_limited", retryAt: 1000 })
  expect(
    await checkCommandAuthor(reader(new GithubRequestError(403, 1000)), author, ["42"])
  ).toEqual({ outcome: "unavailable", reason: "credential_rejected" })
  expect(
    await checkCommandAuthor(reader(new GithubRequestError(401)), author, ["42"])
  ).toMatchObject({
    reason: "credential_rejected",
  })
  expect(await checkCommandAuthor(reader(new GithubRequestError(502)), author, ["42"])).toEqual({
    outcome: "unavailable",
    reason: "transient",
    retryAt: undefined,
  })
  expect(await checkCommandAuthor(reader(new Error("network")), author, ["42"])).toEqual({
    outcome: "unavailable",
    reason: "transient",
  })
})
