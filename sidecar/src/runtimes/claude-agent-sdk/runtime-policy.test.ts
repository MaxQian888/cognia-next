import test from "node:test"
import assert from "node:assert/strict"
import {
  createProtectedClaudeQuery,
  nestedNamespaceRequested,
  requestNestedNamespaceConsent,
  unattendedRetryPolicy,
} from "./runtime-policy.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import type { RuntimeQuery } from "./runtime-types.ts"

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const idle = (): RuntimeQuery => ({
  async *[Symbol.asyncIterator]() {
    await new Promise(() => {})
    yield { type: "never" }
  },
  interrupt() {},
  close() {},
})

test("namespace admission requires Linux and an enabled fail-closed sandbox", () => {
  assert.equal(nestedNamespaceRequested({}, "linux"), false)
  for (const sandbox of [
    { allowNestedUserNamespaces: true },
    { enabled: true, allowNestedUserNamespaces: true, failIfUnavailable: false },
    { enabled: true, allowNestedUserNamespaces: true, allowUnsandboxedCommands: true },
  ])
    assert.throws(
      () => nestedNamespaceRequested({ claudeAgentSdk: { version: 1, sandbox } }, "linux"),
      /fail-closed/
    )
  const send = {
    claudeAgentSdk: {
      version: 1 as const,
      sandbox: { enabled: true, allowNestedUserNamespaces: true },
    },
  }
  assert.throws(() => nestedNamespaceRequested(send, "darwin"), /Linux/)
  assert.equal(nestedNamespaceRequested(send, "linux"), true)
})

test("retry bounds and ledger policy fail closed before starting a subprocess", () => {
  for (const maxWaitMs of [undefined, NaN, Infinity, -1, 59999, 10800001, 60000.5])
    assert.throws(
      () =>
        unattendedRetryPolicy({
          claudeAgentSdk: { version: 1, unattendedRetry: { maxWaitMs: maxWaitMs as number } },
        }),
      /maxWaitMs/
    )
  for (const maxWaitMs of [60000, 10800000])
    assert.equal(
      unattendedRetryPolicy({ claudeAgentSdk: { version: 1, unattendedRetry: { maxWaitMs } } })
        ?.maxWaitMs,
      maxWaitMs
    )
})

for (const behavior of ["deny", "allow_always", "unknown", undefined]) {
  test(`namespace authorization ${String(behavior)} never creates a query`, async () => {
    const pending = new Map<string, PendingApproval>()
    const frames: Record<string, unknown>[] = []
    let created = 0
    const guarded = createProtectedClaudeQuery({
      beforeStart: (signal) =>
        requestNestedNamespaceConsent({
          pendingApprovals: pending,
          sessionId: "s",
          emit: (frame) => frames.push(frame),
          signal,
        }),
      create() {
        created++
        return idle()
      },
    })
    const next = guarded.q[Symbol.asyncIterator]().next()
    await flush()
    const request = frames[0]!
    assert.equal(request.requiresPerCallApproval, true)
    assert.equal(request.suppressAlwaysAllowRule, true)
    assert.equal(request.defaultToNo, true)
    assert.equal(request.permissionClass, "hostConfig")
    pending.get(String(request.requestId))!.resolve({ behavior })
    await assert.rejects(next, /authorization was denied/)
    assert.equal(created, 0)
    assert.equal(pending.size, 0)
    guarded.finish()
  })
}

test("cancelling a pending namespace approval immediately settles it without spawning", async () => {
  const pending = new Map<string, PendingApproval>()
  let created = 0
  const guarded = createProtectedClaudeQuery({
    beforeStart: (signal) =>
      requestNestedNamespaceConsent({
        pendingApprovals: pending,
        sessionId: "s",
        emit() {},
        signal,
      }),
    create() {
      created++
      return idle()
    },
  })
  const next = guarded.q[Symbol.asyncIterator]().next()
  await flush()
  assert.equal(pending.size, 1)
  await guarded.q.interrupt()
  await assert.rejects(next, /cancelled/)
  assert.equal(pending.size, 0)
  assert.equal(created, 0)
  guarded.finish()
})

test("namespace approval TTL denies admission and clears the waiter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending = new Map<string, PendingApproval>()
  const guarded = createProtectedClaudeQuery({
    beforeStart: (signal) =>
      requestNestedNamespaceConsent({
        pendingApprovals: pending,
        sessionId: "s",
        emit() {},
        signal,
        ttlMs: 500,
      }),
    create() {
      assert.fail("expired consent cannot spawn")
    },
  })
  const next = guarded.q[Symbol.asyncIterator]().next()
  await flush()
  t.mock.timers.tick(500)
  await assert.rejects(next, /expired/)
  assert.equal(pending.size, 0)
  guarded.finish()
})

test("explicit consent ignores edited input and only starts its original invocation", async () => {
  const pending = new Map<string, PendingApproval>()
  let created = 0
  let original: unknown
  const guarded = createProtectedClaudeQuery({
    beforeStart: (signal) =>
      requestNestedNamespaceConsent({
        pendingApprovals: pending,
        sessionId: "s",
        emit(frame) {
          original = frame.input
        },
        signal,
      }),
    create() {
      created++
      return {
        ...idle(),
        async *[Symbol.asyncIterator]() {
          yield { type: "result" }
        },
      }
    },
  })
  const next = guarded.q[Symbol.asyncIterator]().next()
  await flush()
  assert.equal(created, 0)
  pending
    .values()
    .next()
    .value!.resolve({ behavior: "allow", updatedInput: { allowNestedUserNamespaces: false } })
  assert.equal((await next).value?.type, "result")
  assert.equal(created, 1)
  assert.equal(Object.isFrozen(original), true)
  guarded.finish()
})

test("one deadline spans normal work, retry waits and delayed control interrupts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let controller!: AbortController
  let closed = 0
  let drained = 0
  const guarded = createProtectedClaudeQuery({
    maxWaitMs: 60000,
    create(value) {
      controller = value
      return {
        ...idle(),
        interrupt: () => new Promise(() => {}),
        close() {
          closed++
        },
      }
    },
    onAbort() {
      drained++
    },
  })
  const next = guarded.q[Symbol.asyncIterator]().next()
  await flush()
  t.mock.timers.tick(30000)
  assert.equal(controller.signal.aborted, false)
  t.mock.timers.tick(30000)
  await assert.rejects(next, /total invocation deadline/)
  assert.equal(controller.signal.aborted, true)
  assert.equal(closed, 1)
  assert.equal(drained, 1)
  guarded.finish()
})

test("cancellation aborts locally even when the SDK interrupt RPC never responds", async () => {
  let signal!: AbortSignal
  let closed = false
  const guarded = createProtectedClaudeQuery({
    create(controller) {
      signal = controller.signal
      return {
        ...idle(),
        interrupt: () => new Promise(() => {}),
        close() {
          closed = true
        },
      }
    },
  })
  const next = guarded.q[Symbol.asyncIterator]().next()
  await flush()
  await guarded.q.interrupt()
  assert.equal(signal.aborted, true)
  assert.equal(closed, true)
  await assert.rejects(next, /cancelled/)
  guarded.finish()
})

test("normal completion and startup errors clear the invocation deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let stopped = 0
  for (const failure of [false, true]) {
    const guarded = createProtectedClaudeQuery({
      maxWaitMs: 60000,
      onAbort() {
        stopped++
      },
      create() {
        if (failure) throw new Error("spawn refused")
        return {
          ...idle(),
          async *[Symbol.asyncIterator]() {
            yield { type: "result" }
          },
        }
      },
    })
    const next = guarded.q[Symbol.asyncIterator]().next()
    if (failure) await assert.rejects(next, /spawn refused/)
    else await next
    guarded.finish()
    t.mock.timers.tick(60000)
  }
  assert.equal(stopped, 0)
})

test("finishing a successful invocation closes its SDK query exactly once", async () => {
  let closed = 0
  const guarded = createProtectedClaudeQuery({
    create() {
      return {
        ...idle(),
        async *[Symbol.asyncIterator]() {
          yield { type: "result" }
        },
        close() {
          closed++
        },
      }
    },
  })
  await guarded.q[Symbol.asyncIterator]().next()
  guarded.finish()
  guarded.finish()
  guarded.q.close?.()
  assert.equal(closed, 1)
})

test("throwing cleanup callbacks cannot escape cancellation or a deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  for (const byDeadline of [false, true]) {
    const guarded = createProtectedClaudeQuery({
      maxWaitMs: 60000,
      create() {
        return {
          ...idle(),
          close() {
            throw new Error("transport broken")
          },
        }
      },
      onAbort() {
        throw new Error("renderer gone")
      },
    })
    const next = guarded.q[Symbol.asyncIterator]().next()
    await flush()
    if (byDeadline) assert.doesNotThrow(() => t.mock.timers.tick(60000))
    else await guarded.q.interrupt()
    await assert.rejects(next, byDeadline ? /deadline/ : /cancelled/)
    assert.doesNotThrow(() => guarded.finish())
  }
})
