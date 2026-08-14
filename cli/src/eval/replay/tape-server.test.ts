/**
 * End-to-end check that a real HTTP client gets a real Anthropic-shaped answer
 * from a tape, keyed by the digest the recorder would have produced.
 */

import { createReplayLedger } from "@/lib/ai/replay/lease"
import { digestAnthropicRequest } from "@/lib/ai/replay/normalize-anthropic-request"
import type { ReplayTapeV1 } from "@cognia/agent-config-types/model-request-surface"
import { createTapeServer, parseActorPath, type TapeServer } from "./tape-server"

const PAYLOAD = {
  model: "claude-opus-5",
  system: "be helpful",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 256,
  stream: true,
}

async function digestOf(payload: unknown = PAYLOAD): Promise<string> {
  const { requestDigest } = await digestAnthropicRequest(payload as Record<string, unknown>, {
    provider: "anthropic",
    purpose: "turn",
  })
  return requestDigest
}

function tape(requestDigest: string, overrides: Partial<ReplayTapeV1> = {}): ReplayTapeV1 {
  return {
    schemaVersion: 1,
    tapeId: "tape-1",
    match: { actorRef: "root", purpose: "turn", requestDigest },
    behavior: { kind: "stream", chunksRef: "chunks-1" },
    synthetic: true,
    ...overrides,
  }
}

async function post(
  server: TapeServer,
  actorRef: string,
  body: unknown = PAYLOAD
): Promise<Response> {
  return fetch(`${server.baseUrlFor(actorRef)}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("parseActorPath", () => {
  it("splits the actor prefix from the API path", () => {
    expect(parseActorPath("/a/child-1/v1/messages")).toEqual({
      actorRef: "child-1",
      apiPath: "/v1/messages",
    })
  })

  it("decodes an escaped actor ref", () => {
    expect(parseActorPath("/a/child%2F1/v1/messages").actorRef).toBe("child/1")
  })

  it("leaves a plain path alone", () => {
    expect(parseActorPath("/v1/messages")).toEqual({ apiPath: "/v1/messages" })
  })

  it("does not treat a bare prefix as a route", () => {
    expect(parseActorPath("/a/root")).toEqual({ apiPath: "/" })
  })
})

describe("tape server", () => {
  let server: TapeServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it("streams a matched tape as Anthropic SSE", async () => {
    const digest = await digestOf()
    const ledger = createReplayLedger([tape(digest)])
    server = createTapeServer({
      ledger,
      resolveChunks: async () => ["Hel", "lo!"],
    })
    await server.start()

    const response = await post(server, "root")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")

    const body = await response.text()
    expect(body).toContain('"text":"Hel"')
    expect(body).toContain('"text":"lo!"')
    expect(body).toContain("message_stop")
    expect(ledger.assertConsumed().ok).toBe(true)
  })

  it("returns a whole message when the caller did not ask to stream", async () => {
    const payload = { ...PAYLOAD, stream: false }
    const ledger = createReplayLedger([tape(await digestOf(payload))])
    server = createTapeServer({ ledger, resolveChunks: async () => ["Hel", "lo!"] })
    await server.start()

    const response = await post(server, "root", payload)
    const body = (await response.json()) as { content: Array<{ text: string }> }
    expect(body.content[0].text).toBe("Hello!")
  })

  it("refuses an unmatched request instead of inventing an answer", async () => {
    // The whole point: a replay that fabricates a completion passes while
    // testing nothing.
    const ledger = createReplayLedger([])
    server = createTapeServer({ ledger, resolveChunks: async () => [] })
    await server.start()

    const response = await post(server, "root")
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("replay_no_tape")
    expect(body.error.message).toContain("sha256:")
    expect(ledger.assertConsumed().ok).toBe(false)
  })

  it("routes each actor to its own lease by URL", async () => {
    const digest = await digestOf()
    const ledger = createReplayLedger([
      tape(digest, { tapeId: "root-tape" }),
      tape(digest, {
        tapeId: "child-tape",
        match: { actorRef: "child-1", purpose: "turn", requestDigest: digest },
      }),
    ])
    const served: string[] = []
    server = createTapeServer({
      ledger,
      resolveChunks: async (ref) => {
        served.push(ref)
        return ["ok"]
      },
    })
    await server.start()

    await (await post(server, "child-1")).text()
    await (await post(server, "root")).text()

    expect(server.handled.map((entry) => entry.actorRef)).toEqual(["child-1", "root"])
    expect(server.handled.every((entry) => entry.matched)).toBe(true)
    expect(ledger.assertConsumed().ok).toBe(true)
    expect(served).toHaveLength(2)
  })

  it("serves a recorded provider error with its status", async () => {
    const digest = await digestOf()
    const ledger = createReplayLedger([
      tape(digest, {
        behavior: { kind: "error", status: 429, code: "rate_limit_error", message: "slow down" },
      }),
    ])
    server = createTapeServer({ ledger, resolveChunks: async () => [] })
    await server.start()

    const response = await post(server, "root")
    expect(response.status).toBe(429)
    const body = (await response.json()) as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_error")
  })

  it("cuts a cancelled stream mid-flight rather than ending it cleanly", async () => {
    // A clean end would look like a short successful turn and never exercise
    // the recovery path.
    const digest = await digestOf()
    const ledger = createReplayLedger([
      tape(digest, { behavior: { kind: "cancel", afterChunks: 1 } }),
    ])
    server = createTapeServer({ ledger, resolveChunks: async () => ["one", "two", "three"] })
    await server.start()

    await expect(post(server, "root").then((response) => response.text())).rejects.toThrow()
  })

  it("rejects anything that is not POST /v1/messages", async () => {
    server = createTapeServer({ ledger: createReplayLedger([]), resolveChunks: async () => [] })
    await server.start()

    const response = await fetch(`${server.baseUrl}/v1/models`)
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { type: string } }
    expect(body.error.type).toBe("replay_unsupported_route")
  })

  it("rejects a body that is not JSON", async () => {
    server = createTapeServer({ ledger: createReplayLedger([]), resolveChunks: async () => [] })
    await server.start()

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    })
    expect(response.status).toBe(400)
  })

  it("surfaces a chunk-resolver failure instead of hanging", async () => {
    const digest = await digestOf()
    server = createTapeServer({
      ledger: createReplayLedger([tape(digest)]),
      resolveChunks: async () => {
        throw new Error("asset missing")
      },
    })
    await server.start()

    const response = await post(server, "root")
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("asset missing")
  })

  it("binds loopback only", async () => {
    server = createTapeServer({ ledger: createReplayLedger([]), resolveChunks: async () => [] })
    await server.start()
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})
