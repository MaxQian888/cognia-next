import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import {
  ENGINE_IDS,
  ENGINES_ENV,
  __unloadEnginesForTesting,
  enginesFromEnv,
  loadEngines,
  loadedEngine,
  requireEngine,
} from "./engines.ts"
import { dispatch } from "./index.ts"
import { resolveRuntimeAdapter } from "./registry.ts"

test("enginesFromEnv loads every engine unless the host names some", () => {
  assert.deepEqual(enginesFromEnv({}), [...ENGINE_IDS])
  assert.deepEqual(enginesFromEnv({ [ENGINES_ENV]: "  " }), [...ENGINE_IDS])
  assert.deepEqual(enginesFromEnv({ [ENGINES_ENV]: "ai-sdk" }), ["ai-sdk"])
  assert.deepEqual(enginesFromEnv({ [ENGINES_ENV]: "ai-sdk, claude-agent-sdk,ai-sdk" }), [
    "ai-sdk",
    "claude-agent-sdk",
  ])
  assert.throws(() => enginesFromEnv({ [ENGINES_ENV]: "ai-sdk,pi" }), /unknown engines: pi/)
  assert.throws(() => enginesFromEnv({ [ENGINES_ENV]: "," }), /unknown engines/)
})

test("an engine this host did not load fails closed, naming it", async () => {
  __unloadEnginesForTesting()
  try {
    assert.equal(loadedEngine("ai-sdk"), undefined)
    assert.throws(() => requireEngine("claude-agent-sdk"), /"claude-agent-sdk" is not loaded/)
    const params = {
      sessionId: "s",
      firstPrompt: "hi",
      emit() {},
      log() {},
    }
    // The capability tables stay available without loading any engine.
    assert.equal(resolveRuntimeAdapter("ai-sdk")?.id, "ai-sdk")
    assert.throws(
      () => dispatch({ ...params, sendOptions: { execution: { runtimeAdapter: "ai-sdk" } } }),
      /"ai-sdk" is not loaded/
    )
    assert.throws(
      () => dispatch({ ...params, sendOptions: { provider: "anthropic" } }),
      /"claude-agent-sdk" is not loaded/
    )
    await loadEngines(["ai-sdk"])
    const first = loadedEngine("ai-sdk")
    assert.equal(typeof first?.dispatch, "function")
    await loadEngines(["ai-sdk"])
    assert.equal(loadedEngine("ai-sdk"), first, "loading is idempotent")
    assert.equal(loadedEngine("claude-agent-sdk"), undefined)
  } finally {
    __unloadEnginesForTesting()
  }
})

interface Frame {
  type: string
  sessionId?: string
  error?: unknown
  ok?: boolean
  requestId?: string
  event?: { type?: string; message?: { content?: { type: string; text?: string }[] } }
  [field: string]: unknown
}

/** An OpenAI-compatible provider that answers every turn with one text reply. */
async function scriptedProvider(reply: string): Promise<Server> {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain the request body
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta: unknown, finish_reason: string | null) =>
      res.write(
        `data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      )
    chunk({ role: "assistant", content: reply }, null)
    chunk({}, "stop")
    res.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return server
}

/** Spawn the real host with the Claude Agent SDK made unresolvable. */
function hostWithoutClaudeSdk(env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("../../test-support/block-claude-agent-sdk.ts", import.meta.url).pathname,
      new URL("../../agent-host.mjs", import.meta.url).pathname,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } }
  )
  const frames: Frame[] = []
  let stderr = ""
  let buffer = ""
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        frames.push(JSON.parse(line) as Frame)
      } catch {
        /* not a protocol frame */
      }
    }
  })
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve))
  const wait = async (predicate: (frame: Frame) => boolean, start = 0) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const frame = frames.slice(start).find(predicate)
      if (frame) return frame
      if (child.exitCode !== null) throw new Error(`host exited: ${stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`frame timeout: ${JSON.stringify(frames.slice(start))} ${stderr}`)
  }
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify(message) + "\n")
  return { child, frames, wait, send, exited, stderr: () => stderr }
}

test(
  "a host without the Claude Agent SDK runs AI SDK turns and refuses Claude-only work",
  { timeout: 60_000 },
  async () => {
    const provider = await scriptedProvider("ENGINE_ISOLATED_PONG")
    const host = hostWithoutClaudeSdk({ [ENGINES_ENV]: "ai-sdk" })
    const options = {
      provider: "openai",
      model: "scripted",
      cwd: process.cwd(),
      providerCredentials: {
        apiKey: "fixture",
        protocol: "openai",
        baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      },
    }
    try {
      host.send({ type: "send", sessionId: "isolated", prompt: "ping", options })
      const ended = await host.wait(
        (frame) => frame.type === "session_ended" && frame.sessionId === "isolated"
      )
      assert.equal(ended.error, undefined, host.stderr())
      assert.match(JSON.stringify(host.frames), /ENGINE_ISOLATED_PONG/)

      // A turn for the engine this host did not load fails closed.
      const start = host.frames.length
      host.send({
        type: "send",
        sessionId: "claude-turn",
        prompt: "ping",
        options: { ...options, provider: "anthropic" },
      })
      const refused = await host.wait(
        (frame) => frame.type === "session_ended" && frame.sessionId === "claude-turn",
        start
      )
      assert.match(String(refused.error), /"claude-agent-sdk" is not loaded/)

      host.send({ type: "session_api", requestId: "list-1", method: "listSessions" })
      const answer = await host.wait(
        (frame) => frame.type === "session_api_response" && frame.requestId === "list-1"
      )
      assert.equal(answer.ok, false)
      assert.match(String(answer.error), /requires the "claude-agent-sdk" engine/)
    } finally {
      host.child.kill()
      await host.exited
      await new Promise((resolve) => provider.close(resolve))
    }
  }
)

test("the blocker is real: loading the Claude engine without its SDK stops the host", async () => {
  const host = hostWithoutClaudeSdk({ [ENGINES_ENV]: "claude-agent-sdk" })
  host.child.stdin.end()
  const code = await host.exited
  assert.notEqual(code, 0)
  assert.match(host.stderr(), /claude-agent-sdk.*blocked by the test/)
})
