import assert from "node:assert/strict"
import test from "node:test"

import { applyLineFilter, createHostBgShellRegistry } from "./bash-host-sessions.mjs"

/**
 * Scriptable fake host. `handlers[method]` receives params and returns the
 * result; calls are recorded so tests can assert on the wire traffic.
 */
function fakeHost(handlers) {
  const calls = []
  return {
    calls,
    hostRpc: {
      async call(method, params, options) {
        calls.push({ method, params, options })
        const handler = handlers[method]
        if (!handler) throw new Error(`unexpected host_rpc method ${method}`)
        return handler(params)
      },
    },
  }
}

function slice({
  data = "",
  nextOffset = 0,
  status = "running",
  exitCode = null,
  hasMore = false,
}) {
  return { data, nextOffset, status, exitCode, hasMore, fromOffset: 0 }
}

test("applyLineFilter keeps only matching lines", () => {
  assert.equal(applyLineFilter("a\nERROR x\nb", "ERROR"), "ERROR x")
  assert.equal(applyLineFilter("a\nb", "ERROR"), "")
})

test("applyLineFilter passes text through unchanged for an invalid regex", () => {
  // Degrading to "no filter" matches the previous implementation's tolerance;
  // failing the whole read on a bad pattern would be worse.
  assert.equal(applyLineFilter("a\nb", "([unclosed"), "a\nb")
})

test("applyLineFilter is a no-op without a filter", () => {
  assert.equal(applyLineFilter("a\nb", undefined), "a\nb")
  assert.equal(applyLineFilter("", "x"), "")
})

test("spawnBackground sends the session owner and returns the host record", async () => {
  const { hostRpc, calls } = fakeHost({
    "jobs.spawn": () => ({ id: "job-1", command: "pnpm dev", startedAtMs: 1 }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const entry = await reg.spawnBackground({
    command: "pnpm dev",
    shell: "/bin/sh",
    shellArgs: ["-c", "pnpm dev"],
    cwd: "/repo",
    env: { PATH: "/usr/bin" },
  })

  assert.equal(entry.id, "job-1")
  assert.deepEqual(calls[0].params.owner, { kind: "session", sessionId: "s1" })
  assert.equal(calls[0].params.program, "/bin/sh")
  assert.deepEqual(calls[0].params.args, ["-c", "pnpm dev"])
})

test("detach promotes the job to app ownership so it outlives the session", async () => {
  const { hostRpc, calls } = fakeHost({ "jobs.spawn": () => ({ id: "job-1", startedAtMs: 1 }) })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  await reg.spawnBackground({ command: "x", shell: "sh", shellArgs: [], cwd: "/", detach: true })
  assert.deepEqual(calls[0].params.owner, { kind: "app" })
})

test("read advances the cursor so the next read returns only new bytes", async () => {
  let call = 0
  const { hostRpc, calls } = fakeHost({
    "jobs.read": () => {
      call += 1
      return call === 1
        ? slice({ data: "first", nextOffset: 5 })
        : slice({ data: "second", nextOffset: 11 })
    },
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  assert.equal((await reg.read("job-1")).data, "first")
  assert.equal(calls[0].params.fromOffset, 0)
  assert.equal((await reg.read("job-1")).data, "second")
  assert.equal(calls[1].params.fromOffset, 5, "second read resumes at the cursor")
})

test("an explicit fromOffset is a look-back that does not disturb the cursor", async () => {
  // This is only safe because host reads are non-destructive — the whole point
  // of moving from a consume-once cursor to byte offsets.
  const { hostRpc, calls } = fakeHost({
    "jobs.read": (p) =>
      p.fromOffset === 0
        ? slice({ data: "head", nextOffset: 4 })
        : slice({ data: "tail", nextOffset: 8 }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  await reg.read("job-1") // cursor → 4
  await reg.read("job-1", { fromOffset: 0 }) // look-back, cursor unchanged
  await reg.read("job-1")

  assert.equal(calls[2].params.fromOffset, 4, "cursor survived the look-back")
})

test("read surfaces a host error as ok:false instead of throwing", async () => {
  const { hostRpc } = fakeHost({
    "jobs.read": () => {
      throw new Error("no job with id ghost")
    },
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })
  const r = await reg.read("ghost")
  assert.equal(r.ok, false)
  assert.match(r.reason, /no job with id ghost/)
})

test("waitForOutput returns on the first bytes when no filter is given", async () => {
  const { hostRpc } = fakeHost({
    "jobs.wait": () => slice({ data: "hello", nextOffset: 5 }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const r = await reg.waitForOutput("job-1", { waitMs: 1000 })
  assert.equal(r.data, "hello")
  assert.equal(r.status, "running")
})

test("a filtered wait keeps polling until the pattern matches", async () => {
  // THE regression test for the old filter bug: the previous registry advanced
  // its cursor in `read()` and applied the filter afterwards, so non-matching
  // bytes were consumed and a filtered wait could never wait for a pattern.
  const chunks = [
    slice({ data: "compiling...\n", nextOffset: 13 }),
    slice({ data: "still going\n", nextOffset: 25 }),
    slice({ data: "server ready\n", nextOffset: 38 }),
  ]
  let i = 0
  const { hostRpc, calls } = fakeHost({ "jobs.wait": () => chunks[i++] })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const r = await reg.waitForOutput("job-1", { filter: "ready", waitMs: 5000 })
  assert.equal(r.data, "server ready")
  assert.equal(calls.length, 3, "polled until the pattern appeared")
  // And the intervening output was not lost — the cursor tracks the raw stream.
  assert.equal(r.nextOffset, 38)
})

test("a filtered wait gives up when the job exits without matching", async () => {
  const { hostRpc } = fakeHost({
    "jobs.wait": () =>
      slice({ data: "no match here\n", nextOffset: 14, status: "exited", exitCode: 1 }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const r = await reg.waitForOutput("job-1", { filter: "ready", waitMs: 5000 })
  assert.equal(r.data, "", "no matching lines")
  assert.equal(r.status, "exited")
  assert.equal(r.exitCode, 1)
})

test("waitForOutput passes an rpc timeout that outlasts the host-side wait", async () => {
  // Without the margin a healthy long-poll would trip the client's own timeout.
  const { hostRpc, calls } = fakeHost({
    "jobs.wait": () => slice({ data: "x", nextOffset: 1 }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  await reg.waitForOutput("job-1", { waitMs: 10_000 })
  assert.ok(
    calls[0].options.timeoutMs > calls[0].params.waitMs,
    `rpc timeout ${calls[0].options.timeoutMs} must exceed wait ${calls[0].params.waitMs}`
  )
})

test("waitForOutput clamps the budget to the 30s schema cap", async () => {
  const { hostRpc, calls } = fakeHost({ "jobs.wait": () => slice({ data: "x", nextOffset: 1 }) })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  await reg.waitForOutput("job-1", { waitMs: 999_999 })
  assert.ok(calls[0].params.waitMs <= 30_000, `got ${calls[0].params.waitMs}`)
})

test("kill scopes the request to the calling session", async () => {
  const { hostRpc, calls } = fakeHost({
    "jobs.kill": () => ({ id: "job-1", exitCode: null, status: "killed" }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const r = await reg.kill("job-1")
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0].params.requester, { kind: "session", sessionId: "s1" })
})

test("kill reports a host rejection rather than pretending it worked", async () => {
  const { hostRpc } = fakeHost({
    "jobs.kill": () => {
      throw new Error("job job-9 is owned by another session")
    },
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const r = await reg.kill("job-9")
  assert.equal(r.ok, false)
  assert.match(r.reason, /owned by another session/)
})

test("killAll reaps only session-owned jobs, leaving detached ones alive", async () => {
  const { hostRpc, calls } = fakeHost({ "jobs.killOwnedBy": () => ({ killed: ["job-1"] }) })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  await reg.killAll()
  assert.deepEqual(calls[0].params.owner, { kind: "session", sessionId: "s1" })
})

test("killAll swallows host failures so teardown never throws", async () => {
  const { hostRpc } = fakeHost({
    "jobs.killOwnedBy": () => {
      throw new Error("host gone")
    },
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })
  await reg.killAll()
})

test("list maps host records onto the legacy row shape", async () => {
  const { hostRpc } = fakeHost({
    "jobs.list": () => ({
      jobs: [
        {
          id: "job-1",
          command: "pnpm dev",
          cwd: "/repo",
          status: "exited",
          exitCode: 0,
          startedAtMs: 1_000,
          endedAtMs: 3_000,
          owner: { kind: "session", sessionId: "s1" },
          droppedOutputBytes: 0,
        },
      ],
    }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const [row] = await reg.list()
  assert.equal(row.id, "job-1")
  assert.equal(row.status, "exited")
  assert.equal(row.exitCode, 0)
  assert.equal(row.durationMs, 2_000)
  assert.equal(row.cwd, "/repo")
})

test("list reports a terminal status distinct from the legacy running/exited pair", async () => {
  // `interrupted` (app crashed) and `killed` are both "exited" to old callers,
  // but the richer value is what the Job Center needs.
  const { hostRpc } = fakeHost({
    "jobs.list": () => ({
      jobs: [
        { id: "j", command: "x", cwd: "/", status: "interrupted", startedAtMs: 1, endedAtMs: 2 },
      ],
    }),
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })

  const [row] = await reg.list()
  assert.equal(row.status, "exited")
  assert.equal(row.terminalStatus, "interrupted")
})

test("list surfaces a host failure instead of reporting zero shells", async () => {
  // An empty array is a factual claim ("this session has no background
  // shells"). Swallowing the RPC failure made "we could not ask the host" look
  // identical to "there are none", and `list_shells` rendered that as a normal
  // success — so the model concluded its background job had vanished.
  const { hostRpc } = fakeHost({
    "jobs.list": () => {
      throw new Error("host gone")
    },
  })
  const reg = createHostBgShellRegistry({ hostRpc, sessionId: "s1" })
  await assert.rejects(() => reg.list(), /host gone/)
})
