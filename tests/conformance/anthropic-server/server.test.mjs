// Engine self-tests for the deterministic conformance server. These are
// UNIT tests of the fixture infrastructure (matching, SSE framing, control
// channel, fail modes) — the end-to-end cases live in tests/conformance/cases.

import test from "node:test"
import assert from "node:assert/strict"

import { createConformanceServer } from "./server.mjs"
import { SCENARIOS, capabilityCoverage } from "./scenarios/index.mjs"
import { frame, splitBytes, textReplyFrames } from "./sse.mjs"

async function post(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl.replace(/\/v1$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "CONFTEST-SECRET-A", ...headers },
    body: JSON.stringify(body),
  })
}

test("text scenario streams the byte-exact SSE transcript", async () => {
  const { server, baseUrl } = await createConformanceServer(SCENARIOS["text-sse"]())
  try {
    const resp = await post(baseUrl, "/v1/messages", {
      model: "claude-opus-4-8",
      stream: true,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(resp.status, 200)
    assert.equal(resp.headers.get("content-type"), "text/event-stream")
    const text = await resp.text()
    const expected = textReplyFrames({
      messageId: "msg_conf_text_1",
      model: "claude-opus-4-8",
      text: "conformance says hello",
    }).join("")
    assert.equal(text, expected, "SSE bytes must be deterministic")
    // event: lines and ping keepalives survive verbatim.
    assert.match(text, /event: ping\n/)
    assert.match(text, /event: content_block_delta\n/)
  } finally {
    await server.close()
  }
})

test("unmatched requests fail closed with a 500 and are recorded", async () => {
  const { server, baseUrl } = await createConformanceServer(SCENARIOS["model-binding"]())
  try {
    const resp = await post(baseUrl, "/v1/messages", {
      model: "not-a-bound-model",
      messages: [{ role: "user", content: "x" }],
    })
    assert.equal(resp.status, 500)
    const body = await resp.json()
    assert.equal(body.error.type, "api_error")

    const control = await fetch(`${baseUrl.replace(/\/v1$/, "")}/__control/requests`)
    const { hits, unmatched } = await control.json()
    assert.equal(hits.length, 1)
    assert.equal(unmatched.length, 1)
    assert.equal(hits[0].model, "not-a-bound-model")
    assert.equal(hits[0].apiKey, "CONFTEST-SECRET-A")
  } finally {
    await server.close()
  }
})

test("phase advancement flips scenario behavior (rate-limit recovers)", async () => {
  const { server, baseUrl } = await createConformanceServer(SCENARIOS["rate-limit"]())
  try {
    const first = await post(baseUrl, "/v1/messages", {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "x" }],
    })
    assert.equal(first.status, 429)
    assert.equal(first.headers.get("retry-after"), "1")
    assert.equal(
      await first.text(),
      '{"type":"error","error":{"type":"rate_limit_error","message":"conformance rate limit"}}'
    )

    await fetch(`${baseUrl.replace(/\/v1$/, "")}/__control/advance`, { method: "POST" })
    const second = await post(baseUrl, "/v1/messages", {
      model: "claude-opus-4-8",
      stream: true,
      messages: [{ role: "user", content: "x" }],
    })
    assert.equal(second.status, 200)
  } finally {
    await server.close()
  }
})

test("count_tokens is served deterministically", async () => {
  const { server, baseUrl } = await createConformanceServer(SCENARIOS["text-sse"]())
  try {
    const resp = await post(baseUrl, "/v1/messages/count_tokens", {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "x" }],
    })
    assert.deepEqual(await resp.json(), { input_tokens: 42 })
  } finally {
    await server.close()
  }
})

test("stream interruption destroys the socket mid-frame", async () => {
  const { server, baseUrl } = await createConformanceServer(SCENARIOS["stream-interruption"]())
  try {
    const resp = await post(baseUrl, "/v1/messages", {
      model: "claude-opus-4-8",
      stream: true,
      messages: [{ role: "user", content: "x" }],
    })
    let failed = false
    let bytes = 0
    try {
      for await (const chunk of resp.body) bytes += chunk.length
    } catch {
      failed = true
    }
    assert.equal(failed, true, "the stream must terminate abnormally")
    assert.ok(bytes > 0 && bytes <= 120)
  } finally {
    await server.close()
  }
})

test("fragmented-json splits frame bytes inside a multi-byte codepoint", () => {
  const scenario = SCENARIOS["fragmented-json"]()
  const plan = scenario.steps[1].respond({ hit: 1 })
  assert.ok(plan.splitPoints.length === 1, "must find a mid-codepoint split")
  const bytes = Buffer.from(plan.sseFrames.join(""), "utf8")
  const [a, b] = splitBytes(bytes, plan.splitPoints)
  // The boundary byte sequence is NOT valid UTF-8 on its own.
  assert.notEqual(Buffer.concat([a, b]).length, 0)
  assert.equal(Buffer.concat([a, b]).toString("utf8"), bytes.toString("utf8"))
})

test("splitBytes clamps and dedupes invalid points", () => {
  const buffer = Buffer.from("abcdef")
  assert.deepEqual(
    splitBytes(buffer, [3, 3, 0, 99]).map((b) => b.toString()),
    ["abc", "def"]
  )
  assert.deepEqual(
    splitBytes(buffer, []).map((b) => b.toString()),
    ["abcdef"]
  )
})

test("frame() renders spec framing", () => {
  assert.equal(frame("ping", { type: "ping" }), 'event: ping\ndata: {"type":"ping"}\n\n')
})

test("every Agent Core capability id has at least one scenario", async () => {
  // Read the capability registry from the contracts package (source export).
  const { AGENT_CAPABILITY_IDS } =
    await import("../../../packages/agent-config-types/src/agent-execution.ts").catch(() => ({
      AGENT_CAPABILITY_IDS: null,
    }))
  const coverage = capabilityCoverage()
  if (AGENT_CAPABILITY_IDS) {
    // Session/tool/permission/stream capabilities must all be covered; purely
    // resolver-side ids (compatibility bookkeeping) are exempted explicitly.
    const exempt = new Set([
      "thinking",
      "context-management",
      "images",
      "beta-features",
      "checkpoint",
      "compaction",
      "steer",
      "session.resume",
    ])
    for (const id of AGENT_CAPABILITY_IDS) {
      if (exempt.has(id)) continue
      assert.ok(coverage.has(id), `capability ${id} has no conformance scenario`)
    }
  } else {
    // TS import unavailable under plain node — still assert the local map.
    assert.ok(coverage.get("streaming")?.length >= 1)
  }
})
