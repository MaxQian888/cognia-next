/**
 * Coverage for scripts/ci/report/pr-comment.mjs.
 *
 * The property that matters is idempotence: a re-run must UPDATE the existing
 * comment, not append another one. `fetch` is injected so the upsert is
 * exercised end to end without touching the network.
 *
 * Run with: node --test scripts/ci/report/pr-comment.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { COMMENT_MARKER } from "./render.mjs"
import { buildRequest, findExistingComment, parseArgs, upsertComment } from "./pr-comment.mjs"

/** A fetch double that records calls and replays queued responses. */
function fakeFetch(responses) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body })
    const next = responses.shift() ?? { ok: true, status: 200, json: async () => ({}) }
    return next
  }
  impl.calls = calls
  return impl
}

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload })

test("parseArgs requires both a PR number and a body file", () => {
  assert.deepEqual(parseArgs(["--pr", "7", "--body-file", "r.md"]), { pr: "7", bodyFile: "r.md" })
  assert.throws(() => parseArgs(["--body-file", "r.md"]), /--pr is required/)
  assert.throws(() => parseArgs(["--pr", "7"]), /--body-file is required/)
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/)
})

test("findExistingComment matches on the marker, not the author", () => {
  const comments = [
    { id: 1, body: "unrelated chatter" },
    { id: 2, body: `${COMMENT_MARKER}\n## CI report` },
  ]
  assert.equal(findExistingComment(comments).id, 2)
})

test("findExistingComment returns null when there is nothing to update", () => {
  assert.equal(findExistingComment([{ id: 1, body: "hi" }]), null)
  assert.equal(findExistingComment([]), null)
  assert.equal(findExistingComment(undefined), null)
  // A comment with no body at all must not throw.
  assert.equal(findExistingComment([{ id: 1 }]), null)
})

test("buildRequest POSTs a new comment when none exists", () => {
  const req = buildRequest({ repo: "o/r", pr: "7", existingId: undefined, body: "x" })
  assert.equal(req.method, "POST")
  assert.match(req.url, /\/repos\/o\/r\/issues\/7\/comments$/)
})

test("buildRequest PATCHes the existing comment in place", () => {
  const req = buildRequest({ repo: "o/r", pr: "7", existingId: 42, body: "x" })
  assert.equal(req.method, "PATCH")
  assert.match(req.url, /\/repos\/o\/r\/issues\/comments\/42$/)
})

test("upsertComment creates the comment on a first run", async () => {
  const fetchImpl = fakeFetch([jsonResponse([]), jsonResponse({ id: 1 })])
  const result = await upsertComment({
    repo: "o/r",
    pr: "7",
    body: "report",
    token: "t",
    fetchImpl,
  })
  assert.deepEqual(result, { updated: false, id: null })
  assert.equal(fetchImpl.calls[1].method, "POST")
})

test("upsertComment updates the same comment on a re-run — no duplicates", async () => {
  const fetchImpl = fakeFetch([
    jsonResponse([{ id: 99, body: `${COMMENT_MARKER}\nold` }]),
    jsonResponse({ id: 99 }),
  ])
  const result = await upsertComment({
    repo: "o/r",
    pr: "7",
    body: "new",
    token: "t",
    fetchImpl,
  })
  assert.deepEqual(result, { updated: true, id: 99 })
  assert.equal(fetchImpl.calls[1].method, "PATCH")
  assert.match(fetchImpl.calls[1].url, /comments\/99$/)
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].body), { body: "new" })
})

test("upsertComment sends the bearer token on every call", async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization)
    return jsonResponse([])
  }
  await upsertComment({ repo: "o/r", pr: "7", body: "b", token: "secret", fetchImpl })
  assert.ok(seen.every((h) => h === "Bearer secret"))
})

test("upsertComment surfaces an API failure instead of silently doing nothing", async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 403, json: async () => ({}) }])
  await assert.rejects(
    () => upsertComment({ repo: "o/r", pr: "7", body: "b", token: "t", fetchImpl }),
    /403/
  )
})
