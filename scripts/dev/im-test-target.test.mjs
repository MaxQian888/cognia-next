import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  buildTargetEnv,
  handshakeFile,
  handshakePayload,
  removeHandshake,
  startTarget,
  writeHandshake,
} from "./im-test-target.mjs"

const scratch = () => mkdtempSync(path.join(tmpdir(), "cognia-im-target-"))

function fakeFixture(baseUrl = "http://127.0.0.1:45671") {
  return {
    baseUrl,
    stopped: 0,
    async stop() {
      this.stopped++
    },
  }
}

/** Everything `startTarget` touches, injected. */
function deps(overrides = {}) {
  const out = { log: [], tauri: [] }
  const outputDir = scratch()
  return {
    out,
    outputDir,
    args: {
      outputDir,
      env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-inherited" },
      log: (m) => out.log.push(m),
      createFixture: async () => fakeFixture(),
      runTauriImpl: async (argv, options) => {
        out.tauri.push({ argv, options })
        return { code: 0 }
      },
      now: () => 1_700_000_000_000,
      makeToken: () => "deadbeefdeadbeefdeadbeefdeadbeef",
      onCleanup: () => {},
      ...overrides,
    },
  }
}

test("buildTargetEnv points the model at the fixture", () => {
  const env = buildTargetEnv(
    { PATH: "/bin" },
    { baseUrl: "http://127.0.0.1:9", apiKey: "k", controlToken: "t" }
  )
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9")
  assert.equal(env.ANTHROPIC_API_KEY, "k")
  assert.equal(env.E2E_ANTHROPIC_CONTROL_TOKEN, "t")
  assert.equal(env.PATH, "/bin", "the rest of the environment is preserved")
})

test("buildTargetEnv drops an inherited OAuth bearer, which would route past the fixture", () => {
  const env = buildTargetEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-01-abc" },
    { baseUrl: "http://127.0.0.1:9", apiKey: "k", controlToken: "t" }
  )
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in env))
})

test("buildTargetEnv does not mutate the environment it was given", () => {
  const original = { CLAUDE_CODE_OAUTH_TOKEN: "x" }
  buildTargetEnv(original, { baseUrl: "u", apiKey: "k", controlToken: "t" })
  assert.equal(original.CLAUDE_CODE_OAUTH_TOKEN, "x")
})

test("the handshake carries what the runner needs to find and authenticate", () => {
  const payload = handshakePayload({
    baseUrl: "http://127.0.0.1:9",
    controlToken: "t",
    pid: 5,
    startedAt: 1,
  })
  assert.deepEqual(payload, {
    schema: "cognia.im-live.target/1",
    baseUrl: "http://127.0.0.1:9",
    controlToken: "t",
    pid: 5,
    startedAt: 1,
  })
})

test("the handshake is written 0600 — it holds the control token", () => {
  const dir = scratch()
  const file = writeHandshake(
    dir,
    handshakePayload({ baseUrl: "u", controlToken: "t", startedAt: 0 })
  )
  assert.equal(file, handshakeFile(dir))
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).controlToken, "t")
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }
})

test("removeHandshake is safe when there is nothing to remove", () => {
  const dir = scratch()
  removeHandshake(dir)
  removeHandshake(dir)
})

test("startTarget publishes the handshake and launches tauri dev with the fixture env", async () => {
  const { out, outputDir, args } = deps()
  assert.equal(await startTarget(args), 0)
  assert.deepEqual(out.tauri[0].argv, ["dev"])
  const env = out.tauri[0].options.env
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:45671")
  assert.equal(env.E2E_ANTHROPIC_CONTROL_TOKEN, "deadbeefdeadbeefdeadbeefdeadbeef")
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in env))
  assert.ok(out.log.some((l) => l.includes(handshakeFile(outputDir))))
})

test("the control token reaches the fixture's own environment before it starts", async () => {
  const previous = process.env.E2E_ANTHROPIC_CONTROL_TOKEN
  let seenAtStart
  const { args } = deps({
    createFixture: async () => {
      seenAtStart = process.env.E2E_ANTHROPIC_CONTROL_TOKEN
      return fakeFixture()
    },
  })
  try {
    await startTarget(args)
    assert.equal(seenAtStart, "deadbeefdeadbeefdeadbeefdeadbeef")
  } finally {
    if (previous === undefined) delete process.env.E2E_ANTHROPIC_CONTROL_TOKEN
    else process.env.E2E_ANTHROPIC_CONTROL_TOKEN = previous
  }
})

test("the handshake is removed and the fixture stopped when tauri exits", async () => {
  const fixture = fakeFixture()
  const { outputDir, args } = deps({ createFixture: async () => fixture })
  await startTarget(args)
  assert.throws(() => readFileSync(handshakeFile(outputDir), "utf8"), /ENOENT/)
  assert.equal(fixture.stopped, 1)
})

test("a crashing tauri still tears down the handshake", async () => {
  const fixture = fakeFixture()
  const { outputDir, args } = deps({
    createFixture: async () => fixture,
    runTauriImpl: async () => {
      throw new Error("tauri binary missing")
    },
  })
  await assert.rejects(startTarget(args), /tauri binary missing/)
  assert.throws(() => readFileSync(handshakeFile(outputDir), "utf8"), /ENOENT/)
  assert.equal(fixture.stopped, 1)
})

test("a signal handler removes the handshake exactly once", async () => {
  let handler
  const { outputDir, args } = deps({ onCleanup: (fn) => (handler = fn) })
  await startTarget(args)
  handler()
  handler()
  assert.throws(() => readFileSync(handshakeFile(outputDir), "utf8"), /ENOENT/)
})

test("startTarget returns tauri's own exit code", async () => {
  const { args } = deps({ runTauriImpl: async () => ({ code: 3 }) })
  assert.equal(await startTarget(args), 3)
})

test("a signal-terminated tauri is reported as a failure, not a success", async () => {
  const { args } = deps({ runTauriImpl: async () => ({ code: null, signal: "SIGKILL" }) })
  assert.equal(await startTarget(args), 1)
})
