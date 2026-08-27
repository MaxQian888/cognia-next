// End-to-end through the seam that matters: the target boots the REAL fixture,
// publishes its handshake, and the runner discovers it, authenticates with the
// token it never saw, and reads back the marker of a prompt that was posted in
// between. Every other test stubs one side of that; this one stubs neither.
//
// The only thing faked here is the Tauri process itself — starting the desktop
// app takes minutes and needs a build.

import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

globalThis.require ??= createRequire(import.meta.url)
const { createMockAnthropicServer } = await import("../../../tests/e2e/mocks/anthropic/server.ts")

import { startTarget } from "../../dev/im-test-target.mjs"
import { readConfig } from "./config.mjs"
import { createFixtureClient, discoverFixture } from "./fixture-client.mjs"
import { buildMarker, newRunId } from "./marker.mjs"

const scratch = () => mkdtempSync(path.join(tmpdir(), "cognia-im-e2e-"))

/**
 * Run `body` while the target is "up": the fake Tauri stands in for the desktop
 * app and resolves only once the body is done, so the handshake and fixture are
 * live for exactly as long as a real session would be.
 */
async function withTarget(outputDir, body) {
  let failure
  await startTarget({
    outputDir,
    env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-should-be-dropped" },
    log: () => {},
    onCleanup: () => {},
    createFixture: async () => {
      const server = createMockAnthropicServer()
      await server.start(0)
      return server
    },
    runTauriImpl: async (_argv, options) => {
      try {
        await body(options.env)
      } catch (error) {
        failure = error
      }
      return { code: 0 }
    },
  })
  if (failure) throw failure
}

test("the runner discovers the target's fixture and proves a prompt reached it", async () => {
  const outputDir = scratch()
  const runId = newRunId()
  const marker = buildMarker("telegram", runId, 1)

  await withTarget(outputDir, async (tauriEnv) => {
    // 1. The app's environment points at the fixture, with no bearer to prefer.
    assert.ok(tauriEnv.ANTHROPIC_BASE_URL.startsWith("http://127.0.0.1:"))
    assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in tauriEnv))

    // 2. The runner finds the fixture with nothing but the output directory.
    const config = readConfig({ IM_LIVE_OUTPUT_DIR: outputDir })
    const target = await discoverFixture(config)
    assert.equal(target.baseUrl, tauriEnv.ANTHROPIC_BASE_URL)
    assert.equal(target.source, path.join(outputDir, "target.json"))

    const client = createFixtureClient({ baseUrl: target.baseUrl, token: target.token })
    assert.equal((await client.requests()).count, 0)

    // 3. Something the app would do: a streaming turn carrying the marker.
    const response = await fetch(`${tauriEnv.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": tauriEnv.ANTHROPIC_API_KEY },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: `@bot ${marker}` }] }],
      }),
    })
    const stream = await response.text()
    assert.equal(response.status, 200)
    assert.ok(
      stream.includes(marker),
      "the echo scenario must return the marker for the reply assertion"
    )

    // 4. The runner sees it, without ever being handed the prompt text.
    const hit = await client.waitForMarker(marker, { timeoutMs: 3000, pollMs: 20 })
    assert.ok(hit, "the fixture must report the marker it captured")
    assert.equal(hit.model, "claude-opus-5")
    assert.equal(hit.stream, true)
  })
})

test("the control token published by the target is actually required", async () => {
  const outputDir = scratch()
  await withTarget(outputDir, async (tauriEnv) => {
    const config = readConfig({ IM_LIVE_OUTPUT_DIR: outputDir })
    const target = await discoverFixture(config)
    assert.ok(target.token.length >= 32, "the target must publish a real token")

    const unauthenticated = createFixtureClient({ baseUrl: tauriEnv.ANTHROPIC_BASE_URL })
    await assert.rejects(unauthenticated.requests(), /rejected the control token/)
  })
})

test("the handshake is gone once the target exits, so a stale run cannot latch on", async () => {
  const outputDir = scratch()
  await withTarget(outputDir, async () => {})
  await assert.rejects(
    discoverFixture(readConfig({ IM_LIVE_OUTPUT_DIR: outputDir })),
    /pnpm im:test:target/
  )
})
