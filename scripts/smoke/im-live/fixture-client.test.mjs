// Drives the REAL fixture (tests/e2e/mocks/anthropic/server.ts), not a stand-in.
//
// A hand-written fake would let the client and the fixture drift apart in the
// exact place it matters: the control-plane contract that carries the harness's
// primary evidence. Node strips the TypeScript natively, so booting the real
// one costs nothing.

import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"

// The fixture reaches for a bare `require("express")` because its other two
// consumers (Playwright global-setup and Jest) load it as CommonJS. Node 26
// strips its types and loads it as ESM, where `require` is not a global — so
// supply one rather than changing a module system two green suites depend on.
globalThis.require ??= createRequire(import.meta.url)

const { createMockAnthropicServer } = await import("../../../tests/e2e/mocks/anthropic/server.ts")
import { buildMarker } from "./marker.mjs"
import {
  FixtureUnavailableError,
  createFixtureClient,
  discoverFixture,
  targetHandshakePath,
} from "./fixture-client.mjs"

const MARKER = buildMarker("telegram", "abcdef0123456789", 1)

/** Post one streaming /v1/messages call carrying `text`, as the sidecar would. */
async function sendPrompt(baseUrl, text) {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "im-live-test" },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    }),
  })
  await res.text()
  return res
}

async function withFixture(fn, { controlToken } = {}) {
  const previous = process.env.E2E_ANTHROPIC_CONTROL_TOKEN
  if (controlToken) process.env.E2E_ANTHROPIC_CONTROL_TOKEN = controlToken
  else delete process.env.E2E_ANTHROPIC_CONTROL_TOKEN
  const server = createMockAnthropicServer()
  await server.start(0)
  try {
    await fn(server)
  } finally {
    await server.stop()
    if (previous === undefined) delete process.env.E2E_ANTHROPIC_CONTROL_TOKEN
    else process.env.E2E_ANTHROPIC_CONTROL_TOKEN = previous
  }
}

test("the fixture binds loopback only", async () => {
  // Asserted against the source rather than by probing an interface: which
  // non-loopback addresses exist varies by machine and by CI runner, and a
  // probe that finds none would pass vacuously. A LAN-reachable fixture would
  // answer unauthenticated /v1/messages for anyone on the network.
  const source = await readFile("tests/e2e/mocks/anthropic/server.ts", "utf8")
  assert.match(source, /app\.listen\(port, "127\.0\.0\.1"/)
})

test("the request log reports markers and never the prompt text", async () => {
  await withFixture(async (server) => {
    const client = createFixtureClient({ baseUrl: server.baseUrl })
    await sendPrompt(
      server.baseUrl,
      `please answer ${MARKER} — my private notes follow: SEKRIT-BODY`
    )

    const log = await client.requests()
    assert.equal(log.count, 1)
    assert.deepEqual(log.hits[0].markers, [MARKER])
    assert.equal(log.hits[0].model, "claude-opus-5")
    assert.equal(log.hits[0].stream, true)
    assert.equal(log.hits[0].messageCount, 1)
    const serialized = JSON.stringify(log)
    assert.ok(!serialized.includes("SEKRIT-BODY"), "prompt text must never cross the control plane")
    assert.ok(!serialized.includes("private notes"), serialized)
  })
})

test("the echo scenario returns the marker, so the platform reply can be asserted", async () => {
  await withFixture(async (server) => {
    const res = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        messages: [{ role: "user", content: `hey bot ${MARKER}` }],
      }),
    })
    const body = await res.json()
    assert.ok(body.content[0].text.includes(MARKER), body.content[0].text)
  })
})

test("reset clears the log so a run only sees its own traffic", async () => {
  await withFixture(async (server) => {
    const client = createFixtureClient({ baseUrl: server.baseUrl })
    await sendPrompt(server.baseUrl, `stale ${MARKER}`)
    assert.equal((await client.requests()).count, 1)
    await client.reset()
    assert.equal((await client.requests()).count, 0)
  })
})

test("waitForMarker resolves once the prompt lands", async () => {
  await withFixture(async (server) => {
    const client = createFixtureClient({ baseUrl: server.baseUrl })
    setTimeout(() => void sendPrompt(server.baseUrl, `late ${MARKER}`), 40)
    const hit = await client.waitForMarker(MARKER, { timeoutMs: 4000, pollMs: 20 })
    assert.ok(hit, "marker should have been captured")
    assert.deepEqual(hit.markers, [MARKER])
  })
})

test("waitForMarker returns null on timeout instead of throwing", async () => {
  await withFixture(async (server) => {
    const client = createFixtureClient({ baseUrl: server.baseUrl })
    assert.equal(await client.waitForMarker(MARKER, { timeoutMs: 60, pollMs: 20 }), null)
  })
})

test("waitForMarker gives up promptly when aborted", async () => {
  await withFixture(async (server) => {
    const client = createFixtureClient({ baseUrl: server.baseUrl })
    const controller = new AbortController()
    controller.abort()
    assert.equal(
      await client.waitForMarker(MARKER, {
        timeoutMs: 60_000,
        pollMs: 20,
        signal: controller.signal,
      }),
      null
    )
  })
})

test("the control token is enforced when the target sets one", async () => {
  await withFixture(
    async (server) => {
      const wrong = createFixtureClient({ baseUrl: server.baseUrl, token: "not-the-token" })
      await assert.rejects(wrong.requests(), (error) => {
        assert.ok(error instanceof FixtureUnavailableError)
        assert.match(error.message, /rejected the control token/)
        return true
      })
      const none = createFixtureClient({ baseUrl: server.baseUrl })
      await assert.rejects(none.requests(), /rejected the control token/)

      const right = createFixtureClient({ baseUrl: server.baseUrl, token: "the-real-token" })
      assert.equal((await right.requests()).count, 0)
    },
    { controlToken: "the-real-token" }
  )
})

test("a token guard never blocks the model endpoint itself", async () => {
  await withFixture(
    async (server) => {
      // The sidecar has no control token; only /__control/* is gated.
      const res = await sendPrompt(server.baseUrl, `guarded ${MARKER}`)
      assert.equal(res.status, 200)
    },
    { controlToken: "the-real-token" }
  )
})

test("an unreachable fixture is reported as such, not as a generic fetch error", async () => {
  const client = createFixtureClient({ baseUrl: "http://127.0.0.1:1" })
  await assert.rejects(client.requests(), (error) => {
    assert.ok(error instanceof FixtureUnavailableError)
    assert.match(error.message, /pnpm im:test:target/)
    return true
  })
})

test("discoverFixture prefers explicit env over the handshake file", async () => {
  const found = await discoverFixture(
    { fixtureUrl: "http://127.0.0.1:4242/", fixtureToken: "tok", outputDir: "unused" },
    {
      readFileImpl: async () => {
        throw new Error("must not read the handshake when env is set")
      },
    }
  )
  assert.deepEqual(found, { baseUrl: "http://127.0.0.1:4242", token: "tok", source: "env" })
})

test("discoverFixture reads the handshake file the target wrote", async () => {
  const found = await discoverFixture(
    { fixtureUrl: "", fixtureToken: "", outputDir: "test-results/im-live" },
    {
      readFileImpl: async () =>
        JSON.stringify({ baseUrl: "http://127.0.0.1:5555", controlToken: "t" }),
    }
  )
  assert.equal(found.baseUrl, "http://127.0.0.1:5555")
  assert.equal(found.token, "t")
  assert.equal(found.source, targetHandshakePath("test-results/im-live"))
})

test("a missing handshake tells the operator to start the target", async () => {
  await assert.rejects(
    discoverFixture(
      { fixtureUrl: "", fixtureToken: "", outputDir: "test-results/im-live" },
      {
        readFileImpl: async () => {
          throw Object.assign(new Error("nope"), { code: "ENOENT" })
        },
      }
    ),
    /pnpm im:test:target/
  )
})

test("a corrupt handshake is reported instead of half-used", async () => {
  await assert.rejects(
    discoverFixture(
      { fixtureUrl: "", fixtureToken: "", outputDir: "d" },
      { readFileImpl: async () => "{not json" }
    ),
    /not valid JSON/
  )
  await assert.rejects(
    discoverFixture(
      { fixtureUrl: "", fixtureToken: "", outputDir: "d" },
      { readFileImpl: async () => JSON.stringify({ controlToken: "t" }) }
    ),
    /no baseUrl/
  )
})
