import assert from "node:assert/strict"
import test from "node:test"

import {
  cliErrorPayload,
  configDir,
  agentDebugEnvironment,
  AGENT_DEBUG_TAURI_CONFIG,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  detectTerminalTauriFailure,
  endpointFilePath,
  isRendererRestartError,
  launchTimeout,
  parseArgs,
  parseEndpoint,
  RENDERER_RESTART_CODES,
  request,
  reconcileDebugSession,
  tauriDevArgs,
  shutdownTrackedSession,
} from "./agent-debug.mjs"

test("stop authenticates without renderer evaluation and kills a wedged owned process group", async () => {
  const session = { pid: 100, healthPid: 101 }
  const calls = []
  let appAlive = true
  await shutdownTrackedSession(
    session,
    {},
    {
      workspace: "/repo",
      send: async (route) => {
        calls.push(route)
        if (route.includes("health")) return { agentDebug: true, pid: 101 }
        throw new Error("GUI thread is not responding")
      },
      alive: (pid) => pid === 101 && appAlive,
      terminate: (pid, signal) => {
        calls.push([pid, signal])
        if (signal === "SIGKILL") appAlive = false
      },
      delay: async () => {},
    }
  )
  assert.deepEqual(calls, [
    "/api/dev/agent/health?nativeOnly=true",
    "/api/dev/agent/shutdown",
    [100, "SIGTERM"],
    [100, "SIGKILL"],
  ])
})

test("stop refuses foreign identity before sending shutdown or signals", async () => {
  const calls = []
  await assert.rejects(
    shutdownTrackedSession(
      { pid: 100, healthPid: 101 },
      {},
      {
        workspace: "/repo",
        send: async (route) => {
          calls.push(route)
          return { agentDebug: true, pid: 999 }
        },
        alive: () => true,
        terminate: () => assert.fail("must not signal a foreign process"),
        delay: async () => {},
      }
    ),
    /cannot validate tracked-session ownership/
  )
  assert.deepEqual(calls, ["/api/dev/agent/health?nativeOnly=true"])
})

test("detects terminal Cargo and Tauri launch failures from the log tail", () => {
  assert.match(
    detectTerminalTauriFailure(
      `error[E0277]: trait bound failed\nerror: could not compile \`cognia\` due to 2 previous errors`
    ),
    /could not compile/
  )
  assert.match(
    detectTerminalTauriFailure(
      `Error The \"beforeDevCommand\" terminated with a non-zero status code.`
    ),
    /beforeDevCommand/
  )
  assert.equal(detectTerminalTauriFailure("Compiling cognia v0.1.0"), null)
})

test("allows a Cognia cold native build to finish by default", () => {
  assert.equal(launchTimeout(), DEFAULT_LAUNCH_TIMEOUT_MS)
  assert.equal(DEFAULT_LAUNCH_TIMEOUT_MS, 1_200_000)
  assert.equal(launchTimeout("120000"), 120_000)
  assert.throws(() => launchTimeout("soon"), /positive number/)
})

test("launch uses the lean agent-debug config and checkout runtimes", () => {
  assert.deepEqual(tauriDevArgs(), [
    "tauri",
    "dev",
    "--features",
    "agent-debug",
    "--config",
    AGENT_DEBUG_TAURI_CONFIG,
  ])
  const environment = agentDebugEnvironment({ PATH: "/bin" }, "/repo")
  assert.equal(environment.COGNIA_AGENT_DEBUG, "1")
  assert.match(
    environment.COGNIA_PLUGIN_NODE_PATH,
    /src-tauri\/resources\/plugin-node\/bin\/node(?:\.exe)?$/
  )
  assert.equal(environment.COGNIA_MCP_SIDECAR_PATH, "/repo/sidecar/cognia-mcp.mjs")
})

test("resolves the Rust directories config path on every desktop platform", () => {
  assert.equal(configDir("darwin", {}, "/Users/test"), "/Users/test/Library/Application Support")
  assert.equal(configDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/test"), "/cfg")
  assert.equal(
    configDir("win32", { APPDATA: "C:\\Users\\test\\Roaming" }, "C:\\Users\\test"),
    "C:\\Users\\test\\Roaming"
  )
  assert.equal(
    endpointFilePath("linux", { COGNIA_CLI_ENDPOINT_FILE: "/tmp/custom.json" }, "/home/test"),
    "/tmp/custom.json"
  )
})

test("accepts only loopback endpoint discovery payloads with a session token", () => {
  assert.deepEqual(
    parseEndpoint(JSON.stringify({ baseUrl: "http://127.0.0.1:4317", devToken: "a".repeat(64) })),
    {
      baseUrl: "http://127.0.0.1:4317",
      devToken: "a".repeat(64),
    }
  )
  assert.equal(
    parseEndpoint(JSON.stringify({ baseUrl: "http://0.0.0.0:4317", devToken: "a".repeat(64) })),
    null
  )
  assert.equal(parseEndpoint("not-json"), null)
})

test("parses positional action arguments and boolean flags", () => {
  assert.deepEqual(
    parseArgs(["act", "g2e3", "fill", "hello", "--window", "main", "--include-text"]),
    {
      command: "act",
      positional: ["g2e3", "fill", "hello"],
      options: { window: "main", "include-text": true },
    }
  )
  assert.throws(() => parseArgs(["snapshot", "--window"]), /missing value/)
})

test("request() carries renderer restart details from the bridge error payload", async () => {
  const endpoint = { baseUrl: "http://127.0.0.1:4317", devToken: "a".repeat(64) }
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        code: "webview_renderer_restarted",
        error: "webview renderer restarted: the main web content process terminated",
        window: "main",
        rendererGeneration: 4,
        retryable: true,
      }),
      { status: 503 }
    )

  await assert.rejects(
    request("/api/dev/agent/evaluate", { method: "POST", body: {}, endpoint, fetchImpl }),
    (error) => {
      assert.equal(error.status, 503)
      assert.equal(error.code, "webview_renderer_restarted")
      assert.equal(error.window, "main")
      assert.equal(error.rendererGeneration, 4)
      assert.equal(error.retryable, true)
      assert.equal(isRendererRestartError(error), true)
      return true
    }
  )
})

test("CLI failures keep bridge codes and flag renderer restarts", () => {
  assert.deepEqual(RENDERER_RESTART_CODES, [
    "webview_renderer_restarted",
    "webview_renderer_restarting",
  ])

  const restart = Object.assign(new Error("webview renderer restarted"), {
    code: "webview_renderer_restarted",
    window: "main",
    rendererGeneration: 2,
  })
  const payload = cliErrorPayload(restart)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, "webview_renderer_restarted")
  assert.equal(payload.window, "main")
  assert.equal(payload.rendererGeneration, 2)
  assert.equal(payload.rendererRestarted, true)
  assert.match(payload.hint, /inspect the outcome before retrying/)

  const timeout = Object.assign(new Error("timed out"), { code: "webview_eval_timeout" })
  assert.deepEqual(cliErrorPayload(timeout), {
    ok: false,
    error: "timed out",
    code: "webview_eval_timeout",
  })
  assert.deepEqual(cliErrorPayload(new Error("plain")), { ok: false, error: "plain" })
  assert.equal(isRendererRestartError(timeout), false)
})

test("request uses the supplied remaining budget instead of the fixed transport cap", async () => {
  const endpoint = { baseUrl: "http://127.0.0.1:4317", devToken: "a".repeat(64) }
  await assert.rejects(
    request("/api/dev/agent/health", {
      endpoint,
      timeout: 1,
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "error")
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (init.signal.aborted) throw init.signal.reason
        return new Response(JSON.stringify({ ok: true }))
      },
    }),
    { name: "TimeoutError" }
  )
  assert.deepEqual(
    await request("/api/dev/agent/health", {
      endpoint,
      timeout: 30_000,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true })),
    }),
    { ok: true }
  )
})

test("managed launch identity and no-watch mode survive child rebuilds", () => {
  const session = { sessionId: "managed-run", endpointFile: "/repo/.cache/run/endpoint.json" }
  const environment = agentDebugEnvironment({}, "/repo", session)
  assert.equal(environment.COGNIA_AGENT_DEBUG_SESSION_ID, session.sessionId)
  assert.equal(environment.COGNIA_AGENT_DEBUG_WORKSPACE, "/repo")
  assert.equal(environment.COGNIA_AGENT_DEBUG_ENDPOINT_FILE, session.endpointFile)
  assert.equal(tauriDevArgs({ "no-watch": true }).at(-1), "--no-watch")
  assert.deepEqual(parseArgs(["launch", "--no-watch"]).options, { "no-watch": true })
})

test("managed ownership accepts a rebuilt app with a new PID and instance", () => {
  const session = {
    pid: 100,
    healthPid: 101,
    appInstanceId: "old",
    sessionId: "run-a",
    workspace: "/repo",
  }
  const debugSession = { sessionId: "run-a", workspace: "/repo", pid: 202, appInstanceId: "new" }
  const updated = reconcileDebugSession(
    session,
    { agentDebug: true, pid: 202, debugSession },
    { debugSession }
  )
  assert.equal(updated.healthPid, 202)
  assert.equal(updated.appInstanceId, "new")
  assert.equal(updated.pid, 100)
  assert.equal(session.healthPid, 101)
})

test("managed ownership rejects foreign runs, workspaces and discovery/process disagreement", () => {
  const session = { sessionId: "run-a", workspace: "/repo" }
  const identity = { sessionId: "run-a", workspace: "/repo", pid: 202, appInstanceId: "new" }
  assert.throws(
    () =>
      reconcileDebugSession(
        session,
        { agentDebug: true, pid: 202, debugSession: identity },
        { debugSession: identity },
        "/other"
      ),
    /ownership/
  )
  for (const changed of [
    { sessionId: "run-b" },
    { workspace: "/other" },
    { pid: 303 },
    { appInstanceId: "other" },
  ]) {
    assert.throws(
      () =>
        reconcileDebugSession(
          session,
          { agentDebug: true, pid: 202, debugSession: identity },
          { debugSession: { ...identity, ...changed } }
        ),
      /ownership/
    )
    assert.throws(
      () =>
        reconcileDebugSession(
          session,
          { agentDebug: true, pid: 202, debugSession: { ...identity, ...changed } },
          { debugSession: identity }
        ),
      /ownership/
    )
  }
  assert.throws(
    () =>
      reconcileDebugSession(
        session,
        { agentDebug: false, pid: 202, debugSession: identity },
        { debugSession: identity }
      ),
    /agent-debug/
  )
})

test("legacy sessions retain the exact PID requirement", () => {
  const session = { healthPid: 101 }
  assert.equal(reconcileDebugSession(session, { agentDebug: true, pid: 101 }, {}), session)
  assert.throws(
    () => reconcileDebugSession(session, { agentDebug: true, pid: 202 }, {}),
    /relaunch once/
  )
})

test("CLI errors preserve document epochs and uncertain non-retryable outcomes", () => {
  const error = Object.assign(new Error("document replaced"), {
    code: "webview_document_replaced",
    window: "main",
    documentEpoch: 2,
    retryable: false,
    dispatchState: "unknown",
  })
  assert.deepEqual(cliErrorPayload(error), {
    ok: false,
    error: "document replaced",
    code: "webview_document_replaced",
    window: "main",
    documentEpoch: 2,
    retryable: false,
    dispatchState: "unknown",
  })
})
