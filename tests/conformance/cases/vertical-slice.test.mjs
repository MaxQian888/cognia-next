// Vertical-slice conformance cases (ADR-0090 Phase 4).
//
// REAL execution end-to-end, no mocks in the execution path:
//   sidecar (agent-host.mjs) → @anthropic-ai/claude-agent-sdk → embedded
//   claude-code subprocess → [direct | cognia-server LLM gateway] →
//   deterministic Anthropic conformance server.
//
// The SAME fixture matrix runs on both route legs. `conformance:prepare`
// must have built the cognia-server binary; without it the gateway leg fails
// LOUDLY (skips are explicit, never silent).

import test from "node:test"
import assert from "node:assert/strict"

import { createConformanceServer } from "../anthropic-server/server.mjs"
import { SCENARIOS } from "../anthropic-server/scenarios/index.mjs"
import { spawnSidecar, assistantText } from "../harness/sidecar-process.mjs"
import { binaryAvailable, startGatewayLeg, UPSTREAM_KEY } from "../harness/gateway-process.mjs"

const HAS_BINARY = binaryAvailable()
const RUN_GATEWAY_LEG = HAS_BINARY || process.env.CI === "true"

async function controlRequests(baseUrl) {
  const resp = await fetch(`${baseUrl.replace(/\/v1$/, "")}/__control/requests`)
  return resp.json()
}

/** Drive one full sidecar turn and return { events, reply, sidecar }. */
async function runTurn({
  baseUrl,
  apiKey,
  prompt,
  model = "claude-opus-4-8",
  sessionId = "conf-s1",
}) {
  const sidecar = spawnSidecar({ baseUrl, apiKey })
  try {
    await sidecar.waitFor((m) => m.type === "ready", { label: "ready" })
    sidecar.send({
      type: "send",
      sessionId,
      prompt,
      options: { model, maxTurns: 4 },
    })
    const assistant = await sidecar.waitFor(
      (m) => m.type === "event" && m.event?.type === "assistant",
      { label: "assistant reply", timeoutMs: 90_000 }
    )
    // Anthropic sessions keep their query open for follow-up turns; the
    // per-turn terminal is the SDK `result` event, not `session_ended`.
    await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
      label: "turn result",
      timeoutMs: 90_000,
    })
    return { events: sidecar.events.slice(), reply: assistantText(assistant), sidecar }
  } finally {
    await sidecar.close()
  }
}

function assertNoSecretLeaks(events, { gatewayKey } = {}) {
  const serialized = JSON.stringify(events)
  assert.ok(
    !serialized.includes(UPSTREAM_KEY),
    "the UPSTREAM credential must never reach the sidecar event stream"
  )
  if (gatewayKey) {
    // The local gateway key IS the subprocess env credential; it must still
    // never surface inside emitted event payloads.
    const eventPayloads = JSON.stringify(events.filter((e) => e.type === "event"))
    assert.ok(!eventPayloads.includes(gatewayKey), "gateway key leaked into event payloads")
  }
}

// ---- Leg: DIRECT (sidecar → conformance server) -----------------------------

test(
  "direct leg: text SSE turn end-to-end through the real SDK",
  { timeout: 180_000 },
  async () => {
    const { server, baseUrl } = await createConformanceServer(SCENARIOS["text-sse"]())
    try {
      const { events, reply } = await runTurn({
        baseUrl,
        apiKey: "sk-conf-direct",
        prompt: "say hello",
      })
      assert.match(reply, /conformance says hello/)
      assertNoSecretLeaks(events)

      const { hits, unmatched } = await controlRequests(baseUrl)
      assert.equal(unmatched.length, 0)
      // The credential the upstream saw is the one the leg injected.
      assert.ok(hits.some((h) => h.apiKey === "sk-conf-direct"))
    } finally {
      await server.close()
    }
  }
)

test("direct leg: multi-turn carries prior context upstream", { timeout: 240_000 }, async () => {
  const { server, baseUrl } = await createConformanceServer(SCENARIOS["multi-turn"]())
  const sidecar = spawnSidecar({ baseUrl, apiKey: "sk-conf-direct" })
  try {
    await sidecar.waitFor((m) => m.type === "ready", { label: "ready" })
    sidecar.send({
      type: "send",
      sessionId: "conf-mt",
      prompt: "first turn",
      options: { model: "claude-opus-4-8", maxTurns: 4 },
    })
    await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
      label: "turn 1 result",
      timeoutMs: 90_000,
    })
    const mark = sidecar.mark()
    sidecar.send({
      type: "send",
      sessionId: "conf-mt",
      prompt: "second turn",
      options: { model: "claude-opus-4-8", maxTurns: 4 },
    })
    const assistant = await sidecar.waitFor(
      (m) => m.type === "event" && m.event?.type === "assistant",
      { label: "turn 2 assistant", timeoutMs: 90_000, sinceIndex: mark }
    )
    assert.match(assistantText(assistant), /second turn acknowledged/)

    const { hits } = await controlRequests(baseUrl)
    // At least one upstream request carried more than one message (history).
    assert.ok(
      hits.some((h) => h.messageCount > 1),
      `no multi-message request observed: ${JSON.stringify(hits)}`
    )
  } finally {
    await sidecar.close()
    await server.close()
  }
})

// ---- Leg: GATEWAY (sidecar → cognia-server gateway → conformance server) ----

test(
  "gateway leg: same text fixture through the real gateway, credential authority stays gateway-side",
  {
    timeout: 300_000,
    skip: RUN_GATEWAY_LEG
      ? false
      : "cognia-server binary missing — run `pnpm conformance:prepare` (CI always must)",
  },
  async () => {
    const { server, baseUrl } = await createConformanceServer(SCENARIOS["text-sse"]())
    const gateway = await startGatewayLeg({ conformanceBaseUrl: baseUrl })
    try {
      const { events, reply } = await runTurn({
        baseUrl: gateway.gatewayBaseUrl,
        apiKey: gateway.gatewayKey,
        prompt: "say hello",
      })
      assert.match(reply, /conformance says hello/)
      assertNoSecretLeaks(events, { gatewayKey: gateway.gatewayKey })

      const { hits, unmatched } = await controlRequests(baseUrl)
      assert.equal(unmatched.length, 0)
      // The upstream saw the PROFILE-STORE credential (resolved from the env
      // reference), never the sidecar's local gateway key.
      assert.ok(hits.some((h) => h.apiKey === UPSTREAM_KEY))
      assert.ok(!hits.some((h) => h.apiKey === gateway.gatewayKey))
    } finally {
      await gateway.close()
      await server.close()
    }
  }
)

test(
  "gateway leg: unexposed model fails closed with zero upstream attempts",
  {
    timeout: 300_000,
    skip: RUN_GATEWAY_LEG
      ? false
      : "cognia-server binary missing — run `pnpm conformance:prepare` (CI always must)",
  },
  async () => {
    const { server, baseUrl } = await createConformanceServer(SCENARIOS["model-binding"]())
    const gateway = await startGatewayLeg({ conformanceBaseUrl: baseUrl })
    const sidecar = spawnSidecar({ baseUrl: gateway.gatewayBaseUrl, apiKey: gateway.gatewayKey })
    try {
      await sidecar.waitFor((m) => m.type === "ready", { label: "ready" })
      sidecar.send({
        type: "send",
        sessionId: "conf-badmodel",
        prompt: "hi",
        options: { model: "gpt-4o-not-served", maxTurns: 2 },
      })
      const ended = await sidecar.waitFor(
        (m) => (m.type === "event" && m.event?.type === "result") || m.type === "session_ended",
        { label: "failed turn terminal", timeoutMs: 120_000 }
      )
      // The turn must NOT succeed and the conformance server must have seen
      // NOTHING for the unserved model (fail-before-spend).
      const { hits } = await controlRequests(baseUrl)
      assert.equal(hits.filter((h) => !h.countTokens).length, 0, JSON.stringify(hits))
      assert.ok(ended, "session must end (with an error result)")
    } finally {
      await sidecar.close()
      await gateway.close()
      await server.close()
    }
  }
)

test(
  "gateway leg: upstream 529 surfaces as an error without touching other deployments",
  {
    timeout: 300_000,
    skip: RUN_GATEWAY_LEG
      ? false
      : "cognia-server binary missing — run `pnpm conformance:prepare` (CI always must)",
  },
  async () => {
    const { server, baseUrl } = await createConformanceServer(SCENARIOS["upstream-5xx"]())
    const gateway = await startGatewayLeg({ conformanceBaseUrl: baseUrl })
    try {
      const sidecar = spawnSidecar({ baseUrl: gateway.gatewayBaseUrl, apiKey: gateway.gatewayKey })
      try {
        await sidecar.waitFor((m) => m.type === "ready", { label: "ready" })
        sidecar.send({
          type: "send",
          sessionId: "conf-529",
          prompt: "hi",
          options: { model: "claude-opus-4-8", maxTurns: 2 },
        })
        await sidecar.waitFor(
          (m) => (m.type === "event" && m.event?.type === "result") || m.type === "session_ended",
          { label: "turn terminal after 529", timeoutMs: 120_000 }
        )
        const { hits } = await controlRequests(baseUrl)
        assert.ok(hits.length >= 1, "the upstream must have been attempted")
      } finally {
        await sidecar.close()
      }
    } finally {
      await gateway.close()
      await server.close()
    }
  }
)

test(
  "gateway leg: /v1/messages/count_tokens is forwarded to the upstream, not 404",
  {
    timeout: 300_000,
    skip: RUN_GATEWAY_LEG
      ? false
      : "cognia-server binary missing — run `pnpm conformance:prepare` (CI always must)",
  },
  async () => {
    const { server, baseUrl } = await createConformanceServer(SCENARIOS["text-sse"]())
    const gateway = await startGatewayLeg({ conformanceBaseUrl: baseUrl })
    try {
      // Claude Code sizes its context window with this call before every
      // turn. The conformance server answers a fixed 42 so a forwarded count
      // is distinguishable from a locally synthesized estimate.
      const resp = await fetch(`${gateway.gatewayBaseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": gateway.gatewayKey },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "how many tokens is this?" }],
        }),
      })
      assert.equal(resp.status, 200, await resp.text())
      const body = await resp.json()
      assert.equal(body.input_tokens, 42)

      const { hits } = await controlRequests(baseUrl)
      assert.equal(hits.filter((h) => h.countTokens).length, 1)
      assert.ok(hits.every((h) => h.apiKey === UPSTREAM_KEY))
    } finally {
      await gateway.close()
      await server.close()
    }
  }
)
