import { GithubRequestError } from "@cognia/github-bot-kit"

import { AUTHOR, fixture, issueComment, NOW } from "./comment-bot.test-helpers"
import { sha256Hex, type CommandSourceV1 } from "./command-source"
import { readerFor } from "./identity"
import { AuthorCheckUnavailableError, authorizeAuthor, recheckSource } from "./recheck"

async function source(body: string, over: Partial<CommandSourceV1> = {}): Promise<CommandSourceV1> {
  return {
    schemaVersion: 1,
    ingress: "webhook",
    repositoryId: "4242",
    repository: "acme/widgets",
    threadKind: "issue",
    threadNumber: 7,
    sourceKind: "issue_comment",
    sourceId: "11",
    sourceRevision: new Date(NOW - 60_000).toISOString(),
    sourceCreatedAt: new Date(NOW - 60_000).toISOString(),
    sourceBodyHash: await sha256Hex(body),
    actor: AUTHOR,
    verb: "ask",
    request: "why",
    aliased: false,
    ...over,
  }
}

it("sees the command as GitHub has it now", async () => {
  const f = fixture()
  const reader = readerFor(f.context, f.run, f.config)
  const body = "@cognia-bot ask why"
  f.github.comments.set(11, issueComment(11, body))
  const current = await source(body)
  expect(await recheckSource(reader, current, f.config, f.now)).toEqual({ status: "current" })
  // Edited: a new version or new text.
  f.github.comments.set(11, issueComment(11, `${body}!`))
  expect(await recheckSource(reader, current, f.config, f.now)).toEqual({ status: "superseded" })
  f.github.comments.set(11, issueComment(11, body, { updated_at: new Date(NOW).toISOString() }))
  expect(await recheckSource(reader, current, f.config, f.now)).toEqual({ status: "superseded" })
  // Deleted.
  f.github.comments.delete(11)
  expect(await recheckSource(reader, current, f.config, f.now)).toEqual({ status: "deleted" })
})

it("expires a command by its latest version, unless publishing an already approved answer", async () => {
  const f = fixture()
  const reader = readerFor(f.context, f.run, f.config)
  const body = "@cognia-bot ask why"
  const old = new Date(NOW - 25 * 3_600_000).toISOString()
  f.github.comments.set(11, issueComment(11, body, { created_at: old, updated_at: old }))
  const stale = await source(body, { sourceRevision: old })
  expect(await recheckSource(reader, stale, f.config, f.now)).toEqual({ status: "expired" })
  expect(await recheckSource(reader, stale, f.config, f.now, { checkAge: false })).toEqual({
    status: "current",
  })
})

it("re-reads line comments and reviews at their own paths", async () => {
  const f = fixture()
  const reader = readerFor(f.context, f.run, f.config)
  const body = "@cognia-bot ask"
  f.github.reviewComments.set(12, {
    ...issueComment(12, body),
    pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/8",
  })
  const line = await source(body, { sourceKind: "review_comment", sourceId: "12", threadNumber: 8 })
  expect(await recheckSource(reader, line, f.config, f.now)).toEqual({ status: "current" })
  const submitted = new Date(NOW - 60_000).toISOString()
  f.github.reviews.set(13, {
    id: 13,
    body,
    submitted_at: submitted,
    user: AUTHOR,
    state: "COMMENTED",
  })
  const review = await source(body, {
    sourceKind: "review",
    sourceId: "13",
    threadNumber: 8,
    sourceRevision: submitted,
  })
  expect(await recheckSource(reader, review, f.config, f.now)).toEqual({ status: "current" })
})

it("authorizes by allowlist and live permission, and refuses to guess when GitHub cannot answer", async () => {
  const f = fixture()
  const reader = readerFor(f.context, f.run, f.config)
  await expect(authorizeAuthor(reader, AUTHOR, f.config)).resolves.toEqual({
    outcome: "allowed",
    permission: "write",
  })
  f.github.permissions.set(AUTHOR.login, { permission: "read", id: AUTHOR.id })
  await expect(authorizeAuthor(reader, AUTHOR, f.config)).resolves.toMatchObject({
    outcome: "denied",
    reason: "insufficient_permission",
  })
  f.mocks.request.mockRejectedValueOnce(new GithubRequestError(429, NOW + 1000, true))
  await expect(authorizeAuthor(reader, AUTHOR, f.config)).rejects.toBeInstanceOf(
    AuthorCheckUnavailableError
  )
  await expect(authorizeAuthor(reader, { ...AUTHOR, id: 7 }, f.config)).resolves.toMatchObject({
    reason: "not_allowlisted",
  })
})
