import test from "node:test"
import assert from "node:assert/strict"

import {
  buildSessionApiResponse,
  callSessionApi,
  handleSessionApi,
  isSessionApiMethod,
  sessionApiParamError,
  SESSION_API_METHODS,
} from "./session-api.mjs"

/** Records every call so the argument ORDER can be asserted, not just the fact. */
function fakeApi() {
  const calls = []
  const api = {}
  for (const name of Object.keys(SESSION_API_METHODS)) {
    api[name] = async (...args) => {
      calls.push({ name, args })
      return { called: name }
    }
  }
  return { api, calls }
}

const STORE = { append: () => {}, load: () => {} }

test("only the eleven documented methods are reachable", () => {
  assert.equal(Object.keys(SESSION_API_METHODS).length, 11)
  for (const name of Object.keys(SESSION_API_METHODS)) {
    assert.equal(isSessionApiMethod(name), true, name)
  }
  // The allowlist is the same defence as the control frame's: a hostile frame
  // must never reflectively reach an arbitrary SDK export.
  for (const name of ["query", "startup", "__proto__", "constructor", "", null, 7]) {
    assert.equal(isSessionApiMethod(name), false, String(name))
  }
})

test("mutating methods are flagged as such", () => {
  // Four of these rewrite a user's transcripts; `deleteSession` removes one.
  const mutating = Object.entries(SESSION_API_METHODS)
    .filter(([, spec]) => spec.mutates)
    .map(([name]) => name)
    .sort()
  assert.deepEqual(mutating, [
    "deleteSession",
    "forkSession",
    "importSessionToStore",
    "renameSession",
    "tagSession",
  ])
})

// ---- params -------------------------------------------------------------------

test("a missing session id is refused before it reaches the SDK", () => {
  // An empty id is not harmless there: it can mean "search every project
  // directory", and `deleteSession` acts on what it finds.
  for (const method of [
    "getSessionInfo",
    "getSessionMessages",
    "listSubagents",
    "deleteSession",
    "forkSession",
    "importSessionToStore",
  ]) {
    assert.equal(sessionApiParamError(method, {}), "invalid_session_id", method)
    assert.equal(sessionApiParamError(method, { sessionId: "" }), "invalid_session_id", method)
    assert.equal(sessionApiParamError(method, { sessionId: "s1" }), null, method)
  }
})

test("the two-argument methods validate their second argument too", () => {
  assert.equal(sessionApiParamError("getSubagentMessages", { sessionId: "s1" }), "invalid_agent_id")
  assert.equal(sessionApiParamError("renameSession", { sessionId: "s1" }), "invalid_title")
  assert.equal(
    sessionApiParamError("renameSession", { sessionId: "s1", title: "" }),
    "invalid_title"
  )
})

test("tagSession accepts null — that is how a tag is cleared", () => {
  assert.equal(sessionApiParamError("tagSession", { sessionId: "s1", tag: null }), null)
  assert.equal(sessionApiParamError("tagSession", { sessionId: "s1", tag: "todo" }), null)
  assert.equal(sessionApiParamError("tagSession", { sessionId: "s1" }), "invalid_tag")
  assert.equal(sessionApiParamError("tagSession", { sessionId: "s1", tag: 7 }), "invalid_tag")
})

test("the argument-free methods take no params", () => {
  assert.equal(sessionApiParamError("listSessions", undefined), null)
  assert.equal(sessionApiParamError("resolveSettings", undefined), null)
})

// ---- invocation ----------------------------------------------------------------

test("each method receives its arguments in the SDK's order", async () => {
  const { api, calls } = fakeApi()
  const run = (method, params) => callSessionApi({ method, params, store: STORE, api })

  await run("getSubagentMessages", { sessionId: "s1", agentId: "a1" })
  await run("renameSession", { sessionId: "s1", title: "New" })
  await run("tagSession", { sessionId: "s1", tag: null })

  assert.deepEqual(calls[0].args.slice(0, 2), ["s1", "a1"])
  assert.deepEqual(calls[1].args.slice(0, 2), ["s1", "New"])
  assert.deepEqual(calls[2].args.slice(0, 2), ["s1", null])
})

test("the store is attached by the host, never taken from the params", async () => {
  // The descriptor names a BACKEND, never a location. A caller that could
  // supply its own store would be naming where session data lands.
  const { api, calls } = fakeApi()
  await callSessionApi({
    method: "getSessionInfo",
    params: { sessionId: "s1", sessionStore: { evil: true } },
    store: STORE,
    api,
  })
  assert.equal(calls[0].args[1].sessionStore, STORE)
})

test("`dir` is forwarded, and absent when not asked for", async () => {
  const { api, calls } = fakeApi()
  await callSessionApi({ method: "listSessions", params: { dir: "/proj" }, store: STORE, api })
  await callSessionApi({ method: "listSessions", params: {}, store: STORE, api })
  assert.equal(calls[0].args[0].dir, "/proj")
  assert.equal("dir" in calls[1].args[0], false)
})

test("resolveSettings is not handed a store", async () => {
  // It reads the settings layers; a store there would be meaningless and
  // would suggest it consults session data.
  const { api, calls } = fakeApi()
  await callSessionApi({ method: "resolveSettings", params: {}, store: STORE, api })
  assert.equal("sessionStore" in calls[0].args[0], false)
})

test("importSessionToStore refuses to run without a store", async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(
    callSessionApi({ method: "importSessionToStore", params: { sessionId: "s1" }, api }),
    /no_session_store/
  )
  assert.equal(calls.length, 0, "it must fail before reaching the SDK")
})

test("an unknown method and a bad param both throw before any SDK call", async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(callSessionApi({ method: "dropAll", api }), /unknown_method/)
  await assert.rejects(
    callSessionApi({ method: "deleteSession", params: {}, api }),
    /invalid_session_id/
  )
  assert.equal(calls.length, 0)
})

// ---- the frame -------------------------------------------------------------------

test("buildSessionApiResponse omits an undefined result and defaults the error", () => {
  assert.deepEqual(buildSessionApiResponse({ requestId: "r", method: "tagSession", ok: true }), {
    type: "session_api_response",
    requestId: "r",
    method: "tagSession",
    ok: true,
  })
  assert.equal(buildSessionApiResponse({ requestId: "r", method: "x", ok: false }).error, "error")
})

test("handleSessionApi answers success and failure, and never throws", async () => {
  const { api } = fakeApi()
  const out = []
  const emit = (m) => out.push(m)

  await handleSessionApi(
    { requestId: "r1", method: "listSessions", params: {} },
    { emit, store: STORE, api }
  )
  assert.equal(out[0].ok, true)
  assert.deepEqual(out[0].result, { called: "listSessions" })

  // A rejected SDK call, a bad param and an unknown method all settle the
  // request — an unanswered requestId hangs the caller to its own timeout.
  await handleSessionApi({ requestId: "r2", method: "deleteSession", params: {} }, { emit, api })
  assert.deepEqual(out[1], {
    type: "session_api_response",
    requestId: "r2",
    method: "deleteSession",
    ok: false,
    error: "invalid_session_id",
  })

  const boom = { ...api, forkSession: async () => Promise.reject(new Error("disk gone")) }
  await handleSessionApi(
    { requestId: "r3", method: "forkSession", params: { sessionId: "s1" } },
    { emit, store: STORE, api: boom }
  )
  assert.equal(out[2].ok, false)
  assert.equal(out[2].error, "disk gone")

  await handleSessionApi({ requestId: "r4", method: "nope" }, { emit, api })
  assert.equal(out[3].error, "unknown_method")
})
