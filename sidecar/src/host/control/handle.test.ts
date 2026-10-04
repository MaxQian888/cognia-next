import type { HostSession } from "../sessions/types.ts"
import test from "node:test"
import assert from "node:assert/strict"
import {
  routeSetMode,
  runControlWithTimeout,
  routeSteer,
  controlPreflight,
  guardedControlParams,
  runtimeStatus,
} from "./handle.ts"

test("runtimeStatus reports only the owning live AI runtime's nonsecret identity", () => {
  assert.deepEqual(runtimeStatus(undefined), { retained: false })
  const session: HostSession = {
    sdkSessionId: "runtime-1",
    multiTurn: true,
    q: { active: false, closed: false },
    sendOptions: {
      provider: "openai",
      cwd: "/workspace",
      transcriptInvalidationId: "g1",
      providerCredentials: { apiKey: "private" },
    },
  }
  assert.deepEqual(runtimeStatus(session), {
    retained: true,
    runtimeAdapter: "ai-sdk",
    sdkSessionId: "runtime-1",
    provider: "openai",
    cwd: "/workspace",
    transcriptInvalidationId: "g1",
    active: false,
  })
  assert.deepEqual(runtimeStatus({ ...session, q: { closed: true } }), { retained: false })
  assert.deepEqual(runtimeStatus({ ...session, multiTurn: false }), { retained: false })
})

// ---- control frame preflight -------------------------------------------------

test("an unallowlisted method is refused before anything else is considered", () => {
  assert.deepEqual(controlPreflight("claude-agent-sdk", "close", {}), { error: "unknown_method" })
  assert.deepEqual(controlPreflight(undefined, "__proto__", {}), { error: "unknown_method" })
})

test("a control the frozen adapter cannot serve returns a typed capability miss", () => {
  // ai-sdk has no `Query` object, so every SDK control is unservable there.
  // Before this the caller got `unsupported_provider`, which says nothing
  // about WHICH capability was missing.
  assert.deepEqual(controlPreflight("ai-sdk", "reloadPlugins", {}), {
    error: "capability_error",
    capability: "plugins.native",
  })
  assert.equal(controlPreflight("claude-agent-sdk", "reloadPlugins", {}), null)
})

test("a legacy session (no frozen adapter) is never capability-gated", () => {
  // ADR-0090 constraint 6: the flag-off queue keeps today's behaviour, where a
  // method the runtime lacks surfaces as `unsupported_provider` downstream.
  assert.equal(controlPreflight(undefined, "reloadPlugins", {}), null)
})

test("an unknown adapter id is permissive rather than fail-closed", () => {
  // Failing closed here would reject every control on a session whose adapter
  // this build simply cannot read — a newer host talking to an older sidecar.
  assert.equal(controlPreflight("runtime-from-the-future", "reloadPlugins", {}), null)
})

test("params are validated after the capability, so the error names the real problem", () => {
  // Both are wrong here. Reporting `invalid_task_id` would send the caller
  // fixing a payload for a rail that could never run the control anyway.
  assert.deepEqual(controlPreflight("ai-sdk", "stopTask", {}), {
    error: "capability_error",
    capability: "tasks.background",
  })
  assert.deepEqual(controlPreflight("claude-agent-sdk", "stopTask", {}), {
    error: "invalid_task_id",
  })
})

test("mode switches commit only after SDK acknowledgement and preserve mode on rejection", async () => {
  let acknowledge!: (value?: unknown) => void
  const pending = new Promise((resolve) => {
    acknowledge = resolve
  })
  const session: HostSession & { sendOptions: NonNullable<HostSession["sendOptions"]> } = {
    sendOptions: { provider: "anthropic", permissionMode: "default" },
    q: { setPermissionMode: () => pending },
  }
  const sessions = new Map([["s", session]])
  const switching = routeSetMode(sessions, { sessionId: "s", mode: "plan" })
  assert.equal(session.sendOptions.permissionMode, "default")
  acknowledge()
  assert.deepEqual(await switching, { ok: true, result: { mode: "plan" } })
  assert.equal(session.sendOptions.permissionMode, "plan")
  session.q!.setPermissionMode = async () => {
    throw new Error("SDK refused")
  }
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "s", mode: "acceptEdits" }), {
    ok: false,
    error: "SDK refused",
  })
  assert.equal(session.sendOptions.permissionMode, "plan")
})

test("AI SDK mode acknowledgement commits locally; stale/missing sessions cannot acknowledge", async () => {
  const session: HostSession & { sendOptions: NonNullable<HostSession["sendOptions"]> } = {
    sendOptions: { provider: "deepseek", permissionMode: "default" },
  }
  const sessions = new Map([["s", session]])
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "s", mode: "auto" }), {
    ok: true,
    result: { mode: "auto" },
  })
  assert.equal(session.sendOptions.permissionMode, "auto")
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "missing", mode: "plan" }), {
    ok: false,
    error: "no_active_session",
  })
})

test("timed-out mode transition retires the uncertain SDK before it can apply later", async () => {
  let acknowledge!: (value?: unknown) => void
  let closed = false
  const session: HostSession & { sendOptions: NonNullable<HostSession["sendOptions"]> } = {
    sendOptions: { provider: "anthropic", permissionMode: "default" },
    closeInput() {
      closed = true
    },
    q: {
      close() {},
      setPermissionMode: () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    },
  }
  const sessions = new Map([["s", session]])
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "s", mode: "plan" }, 5), {
    ok: false,
    error: "control timed out",
  })
  assert.equal(closed, true)
  assert.equal(sessions.has("s"), false)
  acknowledge()
  await Promise.resolve()
  assert.equal(session.sendOptions.permissionMode, "default")
})

test("live MCP changes receive the same guarded relay and cannot reopen a disabled tool surface", () => {
  const servers = {
    remote: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer fixture" },
    },
    local: { command: "node", args: ["tool.mjs"] },
  }
  const result = guardedControlParams("setMcpServers", { servers })
  for (const server of Object.values(
    result.servers as Record<string, { type: string; env: Record<string, string> }>
  )) {
    assert.equal(server.type, "stdio")
    assert.ok(server.env.COGNIA_MCP_RELAY_CONFIG)
  }
  assert.equal(servers.remote.type, "http")
  assert.throws(
    () => guardedControlParams("setMcpServers", { servers }, { toolSurface: "none" }),
    /disabled/
  )
  assert.deepEqual(
    guardedControlParams("setMcpServers", { servers: {} }, { toolSurface: "none" }),
    { servers: {} }
  )
})

test("provider-visible live settings are PII gated without scanning transport credentials", () => {
  for (const method of ["applyFlagSettings", "updateSettings"])
    assert.throws(
      () => guardedControlParams(method, { settings: { outputStyle: "private@example.com" } }),
      /PII gate/
    )
  assert.deepEqual(
    guardedControlParams("updateSettings", { settings: { outputStyle: "concise" } }),
    { settings: { outputStyle: "concise" } }
  )
})

test("routeSteer acknowledges an Anthropic live-input push without changing the turn id", () => {
  const pushed: unknown[] = []
  const session: HostSession & { sendOptions: NonNullable<HostSession["sendOptions"]> } = {
    sendOptions: {},
    turnRef: { id: "turn-original" },
    pushUserMessage: (content: unknown, priority?: string) => {
      pushed.push([content, priority])
      return true
    },
    scheduleSteerInputClose: () => pushed.push("scheduled-close"),
  }
  const sessions = new Map([["s1", session]])

  const result = routeSteer(sessions, {
    sessionId: "s1",
    prompt: [{ type: "text", text: "redirect" }],
    priority: "now",
    sourceMessageId: "om-steer",
  })

  assert.deepEqual(result, {
    ok: true,
    result: { accepted: true, sourceMessageId: "om-steer" },
  })
  assert.deepEqual(pushed, [[[{ type: "text", text: "redirect" }], "now"], "scheduled-close"])
  assert.equal(session.turnRef!.id, "turn-original")
})

test("routeSteer refuses closed, missing, and non-Anthropic sessions", () => {
  assert.deepEqual(routeSteer(new Map(), { sessionId: "missing", prompt: "x" }), {
    ok: false,
    error: "no_active_session",
  })
  assert.deepEqual(
    routeSteer(
      new Map([["s1", { sendOptions: { provider: "openai" }, pushUserMessage: () => true }]]),
      { sessionId: "s1", prompt: "x" }
    ),
    { ok: false, error: "unsupported_provider" }
  )
  assert.deepEqual(
    routeSteer(new Map([["s1", { sendOptions: {}, pushUserMessage: () => false }]]), {
      sessionId: "s1",
      prompt: "x",
    }),
    { ok: false, error: "input_closed" }
  )
})

test("routeSteer validates priority and source-message correlation fields", () => {
  const sessions = new Map([
    [
      "s1",
      {
        sendOptions: {},
        pushUserMessage: () => true,
      },
    ],
  ])
  assert.deepEqual(routeSteer(sessions, { sessionId: "s1", prompt: "x", priority: "immediate" }), {
    ok: false,
    error: "invalid_priority",
  })
  assert.deepEqual(routeSteer(sessions, { sessionId: "s1", prompt: "x", sourceMessageId: 42 }), {
    ok: false,
    error: "invalid_source_message_id",
  })
})

test("runControlWithTimeout resolves a fast control method", async () => {
  const out = await runControlWithTimeout(async (x) => x + 1, null, [41], 1000)
  assert.deepEqual(out, { ok: true, result: 42 })
})

test("runControlWithTimeout maps a thrown error to ok:false", async () => {
  const out = await runControlWithTimeout(
    async () => {
      throw new Error("boom")
    },
    null,
    [],
    1000
  )
  assert.deepEqual(out, { ok: false, error: "boom" })
})

test("runControlWithTimeout returns a timeout error when the method never settles", async () => {
  // A control method that never resolves must not hang the host — the backstop
  // resolves with a timeout error within the deadline. We use a releasable
  // promise (rather than a forever-pending one) so the inner invocation can
  // settle AFTER the assertion, keeping node:test's event loop clean.
  let release!: (value?: unknown) => void
  const slow = new Promise((resolve) => {
    release = resolve
  })
  const started = Date.now()
  const out = await runControlWithTimeout(() => slow, null, [], 30)
  assert.deepEqual(out, { ok: false, error: "control timed out" })
  assert.ok(Date.now() - started < 5000, "must resolve via the deadline, not hang")
  release("late")
  await slow
})

test("runControlWithTimeout binds thisArg for the control method", async () => {
  const q = {
    model: "sonnet",
    async getModel() {
      return this.model
    },
  }
  const out = await runControlWithTimeout(q.getModel, q, [], 1000)
  assert.deepEqual(out, { ok: true, result: "sonnet" })
})
