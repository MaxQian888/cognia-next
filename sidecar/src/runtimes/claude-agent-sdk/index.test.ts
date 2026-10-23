import test from "node:test"
import assert from "node:assert/strict"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { RuntimeDeps } from "./runtime-types.ts"
import { dispatchAnthropic } from "./index.ts"
import { buildPermissionResult } from "../../host/commands/responses.ts"

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const namespace = {
  version: 1 as const,
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowNestedUserNamespaces: true,
  },
  prewarm: { enabled: true },
}

function capture(sendOptions: SendOptions, overrides: RuntimeDeps = {}) {
  const frames: Record<string, unknown>[] = []
  let spawned = 0
  let claimed = 0
  let warmed = 0
  let queryOptions: Options | undefined
  const session = dispatchAnthropic(
    {
      sessionId: "policy-session",
      firstPrompt: "hello",
      sendOptions: { toolSurface: "none", ...sendOptions },
      emit(frame) {
        frames.push(frame)
      },
      log() {},
    },
    {
      platform: "linux",
      ensurePolicyCompatibility: async () => {},
      pool: {
        claim() {
          claimed++
          return null
        },
        async prewarm() {
          warmed++
          return null
        },
      },
      query({ options }) {
        spawned++
        queryOptions = options
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success" }
          },
          interrupt() {},
          close() {},
        }
      },
      ...overrides,
    }
  )
  return {
    session,
    frames,
    stats: () => ({ spawned, claimed, warmed }),
    options: () => queryOptions,
  }
}

test("dispatch registers a synchronous session, then requires one-off Namespace consent before query or pool", async () => {
  const captured = capture({
    claudeAgentSdk: namespace,
    permissionMode: "bypassPermissions",
    bypassPermissionsConfirmed: true,
    permissionProfile: { workspace: "sandbox", outbound: "ask", secrets: "ask", hostConfig: "ask" },
  })
  assert.equal(typeof captured.session.pendingApprovals.get, "function")
  assert.deepEqual(captured.stats(), { spawned: 0, claimed: 0, warmed: 0 })
  await flush()
  const request = captured.frames.find((frame) => frame.type === "permission_request")!
  assert.equal(request.toolName, "Runtime:Sandbox:NestedUserNamespaces")
  captured.session.pendingApprovals
    .get(String(request.requestId))!
    .resolve({ ...buildPermissionResult("allow", { requiresExplicitConsent: true }) })
  await flush()
  assert.deepEqual(captured.stats(), { spawned: 1, claimed: 0, warmed: 0 })
  assert.equal(captured.options()!.sandbox!.allowNestedUserNamespaces, true)
  assert.equal(captured.options()!.sandbox!.failIfUnavailable, true)
  assert.equal(captured.frames.filter((frame) => frame.type === "session_ended").length, 1)
  assert.equal(captured.session._ended, true)
})

test("denied Namespace and unknown host decisions never spawn, even in bypass mode", async () => {
  for (const decision of ["deny", "allow_always", "unknown"]) {
    const captured = capture({
      claudeAgentSdk: namespace,
      permissionMode: "bypassPermissions",
      bypassPermissionsConfirmed: true,
    })
    await flush()
    const request = captured.frames.find((frame) => frame.type === "permission_request")!
    captured.session.pendingApprovals
      .get(String(request.requestId))!
      .resolve({ ...buildPermissionResult(decision, { requiresExplicitConsent: true }) })
    await flush()
    assert.deepEqual(captured.stats(), { spawned: 0, claimed: 0, warmed: 0 })
    assert.equal(captured.session.pendingApprovals.size, 0)
    assert.match(
      String(captured.frames.find((frame) => frame.type === "session_ended")!.error),
      /authorization/
    )
  }
})

test("a hostConfig deny ceiling prevents Namespace approval and query admission", () => {
  assert.throws(
    () =>
      capture({
        claudeAgentSdk: namespace,
        permissionMode: "bypassPermissions",
        bypassPermissionsConfirmed: true,
        permissionProfile: {
          workspace: "sandbox",
          outbound: "ask",
          secrets: "ask",
          hostConfig: "deny",
        },
      }),
    /hostConfig.*den/
  )
})

test("cancel or close before consent cannot create any SDK query", async () => {
  for (const close of [false, true]) {
    const captured = capture({ claudeAgentSdk: namespace })
    await flush()
    if (close) captured.session.q.close?.()
    else await captured.session.q.interrupt()
    await flush()
    assert.deepEqual(captured.stats(), { spawned: 0, claimed: 0, warmed: 0 })
    assert.equal(captured.session.pendingApprovals.size, 0)
    assert.equal(captured.session._ended, true)
  }
})

test("retry policy becomes managed env and abortController, never an SDK option or prewarm", async () => {
  const captured = capture({
    claudeAgentSdk: {
      version: 1,
      unattendedRetry: { maxWaitMs: 60000, usageLimitRecheckMs: 60000 },
      prewarm: { enabled: true },
    },
  })
  await flush()
  assert.deepEqual(captured.stats(), { spawned: 1, claimed: 0, warmed: 0 })
  assert.equal(captured.options()!.env!.CLAUDE_CODE_RETRY_WATCHDOG, "1")
  assert.equal("unattendedRetry" in captured.options()!, false)
  assert.ok(captured.options()!.abortController)
})

test("an incompatible actual CLI cannot start a policy invocation", async () => {
  const captured = capture(
    { claudeAgentSdk: { version: 1, unattendedRetry: { maxWaitMs: 60000 } } },
    {
      ensurePolicyCompatibility: async () => {
        throw new Error("Claude Code >=2.1.305 is required (found 2.1.304)")
      },
    }
  )
  await flush()
  assert.equal(captured.stats().spawned, 0)
  assert.match(
    String(captured.frames.find((frame) => frame.type === "session_ended")!.error),
    /2.1.304/
  )
})

test("retry elapsed deadline terminates once and drains pending round trips", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let abortSignal: AbortSignal | undefined
  let closed = 0
  const captured = capture(
    { claudeAgentSdk: { version: 1, unattendedRetry: { maxWaitMs: 60000 } } },
    {
      query({ options }) {
        abortSignal = options.abortController!.signal
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {})
            yield { type: "never" }
          },
          interrupt: () => new Promise(() => {}),
          close() {
            closed++
          },
        }
      },
    }
  )
  await flush()
  let denied = false
  captured.session.pendingApprovals.set("later-tool", {
    input: {},
    resolve(answer) {
      denied = answer.behavior === "deny"
    },
  })
  captured.session.pushUserMessage("steer", "now")
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(abortSignal!.aborted, true)
  assert.equal(closed, 1)
  assert.equal(denied, true)
  assert.equal(captured.session.pendingApprovals.size, 0)
  assert.equal(captured.session._ended, true)
  const ended = captured.frames.filter((frame) => frame.type === "session_ended")
  assert.equal(ended.length, 1)
  assert.match(String(ended[0]!.error), /total invocation deadline/)
})
