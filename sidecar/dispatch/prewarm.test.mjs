import test from "node:test"
import assert from "node:assert/strict"

import {
  claimedWarmSpare,
  createWarmPool,
  unpoolableReason,
  warmFingerprint,
  DEFAULT_WARM_CAPACITY,
} from "./prewarm.mjs"

const send = (overrides = {}) => ({
  execution: { hostRef: "desktop-sidecar", runtimeAdapter: "claude-agent-sdk" },
  cwd: "/w",
  ...overrides,
})

function fakeWarm() {
  const state = { closed: false, queried: false }
  return {
    state,
    warm: {
      query() {
        if (state.queried) throw new Error("WarmQuery.query() called twice")
        state.queried = true
        return {}
      },
      close() {
        state.closed = true
      },
    },
  }
}

function pool(overrides = {}) {
  const spawned = []
  let clock = 1000
  const p = createWarmPool({
    startup: async () => {
      const w = fakeWarm()
      spawned.push(w)
      return w.warm
    },
    now: () => clock,
    ...overrides,
  })
  return { pool: p, spawned, tick: (ms) => (clock += ms) }
}

// ---- fingerprint --------------------------------------------------------------

test("tenancy is part of the fingerprint", async () => {
  // The one collision that would be a data leak rather than a bug: a warm
  // subprocess has already resolved credentials and read settings.
  assert.notEqual(
    warmFingerprint(send({ execution: { tenantId: "a", runtimeAdapter: "x" } })),
    warmFingerprint(send({ execution: { tenantId: "b", runtimeAdapter: "x" } }))
  )
})

test("every input the handshake bakes in changes the fingerprint", () => {
  const base = warmFingerprint(send())
  const differs = [
    send({ cwd: "/other" }),
    send({ model: "claude-opus-5" }),
    send({ permissionMode: "acceptEdits" }),
    send({ settingSources: ["user"] }),
    send({ additionalDirectories: ["/extra"] }),
    send({ env: { FOO: "1" } }),
    send({ claudeAgentSdk: { sandbox: { enabled: true } } }),
    send({
      execution: {
        hostRef: "desktop-sidecar",
        runtimeAdapter: "claude-agent-sdk",
        credential: { profileRef: "cp-2" },
      },
    }),
    send({
      execution: {
        hostRef: "desktop-sidecar",
        runtimeAdapter: "claude-agent-sdk",
        route: { kind: "gateway", endpoint: "http://127.0.0.1:1" },
      },
    }),
  ]
  for (const options of differs) {
    assert.notEqual(warmFingerprint(options), base, JSON.stringify(options))
  }
})

test("two identical sends share a fingerprint", () => {
  assert.equal(warmFingerprint(send()), warmFingerprint(send()))
})

// ---- what may not be pooled ----------------------------------------------------

test("a legacy send is never pooled", () => {
  // ADR-0090 constraint 6: the flag-off queue spawns per send today.
  assert.match(unpoolableReason({ cwd: "/w" }), /no frozen execution spec/)
})

test("resume, fork and checkpointing all decline the pool, each with a reason", () => {
  // A warm subprocess was spawned WITHOUT --resume and before the session's
  // files existed, so it is a different process than these need.
  assert.match(unpoolableReason(send({ resume: "s-1" })), /resuming/)
  assert.match(unpoolableReason(send({ claudeAgentSdk: { sessionId: "s-1" } })), /resuming/)
  assert.match(unpoolableReason(send({ claudeAgentSdk: { continue: true } })), /resuming/)
  assert.match(
    unpoolableReason(send({ claudeAgentSdk: { enableFileCheckpointing: true } })),
    /checkpointing/
  )
  assert.match(unpoolableReason(send({ forkSession: true })), /forking/)
  assert.match(
    unpoolableReason(send({ claudeAgentSdk: { skills: ["review"] } })),
    /native local skills\/plugins/
  )
  assert.match(
    unpoolableReason(send({ claudeAgentSdk: { plugins: [{ type: "local", path: "/w/plugin" }] } })),
    /native local skills\/plugins/
  )
  assert.match(
    unpoolableReason(send({ claudeAgentSdk: { extraArgs: { verbose: null } } })),
    /raw Claude CLI flags/
  )
  assert.equal(unpoolableReason(send()), null)
})

// ---- pool behaviour ------------------------------------------------------------

test("a warmed subprocess is claimed by a matching send, once", async () => {
  const { pool: p } = pool()
  assert.equal(await p.prewarm(send(), {}), null)
  assert.equal(p.size, 1)

  assert.ok(p.claim(send()))
  assert.equal(p.size, 0)
  // A second claim must miss: WarmQuery.query() may only be called once, so
  // handing the same one out twice yields a query object that throws.
  assert.equal(p.claim(send()), null)
})

test("a send with a different fingerprint never claims another's subprocess", async () => {
  const { pool: p } = pool()
  await p.prewarm(send({ execution: { tenantId: "a", runtimeAdapter: "x" } }), {})
  assert.equal(p.claim(send({ execution: { tenantId: "b", runtimeAdapter: "x" } })), null)
  assert.equal(p.size, 1, "the warm one is still there for its own tenant")
})

test("an unpoolable send never claims, even when a match is warm", async () => {
  const { pool: p } = pool()
  await p.prewarm(send(), {})
  assert.equal(p.claim(send({ resume: "s-1" })), null)
  assert.equal(p.size, 1)
})

test("capacity is reserved before the await, so concurrent prewarms cannot overshoot", async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const spawned = []
  const p = createWarmPool({
    capacity: 2,
    startup: async () => {
      await gate
      const w = fakeWarm()
      spawned.push(w)
      return w.warm
    },
  })

  const attempts = [p.prewarm(send(), {}), p.prewarm(send(), {}), p.prewarm(send(), {})]
  release()
  const reasons = await Promise.all(attempts)

  assert.equal(spawned.length, 2, "the third saw the reservation, not a stale count")
  assert.equal(reasons.filter((r) => r === null).length, 2)
  assert.match(
    reasons.find((r) => r !== null),
    /at capacity/
  )
})

test("a failed startup gives the slot back", async () => {
  let fail = true
  const p = createWarmPool({
    capacity: 1,
    startup: async () => {
      if (fail) {
        fail = false
        throw new Error("spawn refused")
      }
      return fakeWarm().warm
    },
  })
  assert.match(await p.prewarm(send(), {}), /startup failed/)
  assert.equal(p.size, 0, "a leaked reservation would disable the pool permanently")
  assert.equal(await p.prewarm(send(), {}), null)
})

test("an expired subprocess is CLOSED, not just forgotten", async () => {
  // Dropping the reference leaves a real process running for the app's
  // lifetime — the pool's most expensive possible bug.
  const { pool: p, spawned, tick } = pool({ ttlMs: 1000 })
  await p.prewarm(send(), {})
  tick(1001)

  assert.equal(p.claim(send()), null)
  assert.equal(p.size, 0)
  assert.equal(spawned[0].state.closed, true)
})

test("a subprocess still inside its TTL survives an expiry sweep", async () => {
  const { pool: p, spawned, tick } = pool({ ttlMs: 1000 })
  await p.prewarm(send(), {})
  tick(999)
  assert.ok(p.claim(send()))
  assert.equal(spawned[0].state.closed, false)
})

test("closeAll shuts every warm subprocess down", async () => {
  const { pool: p, spawned } = pool()
  await p.prewarm(send(), {})
  await p.prewarm(send({ cwd: "/other" }), {})
  p.closeAll()
  assert.equal(p.size, 0)
  assert.deepEqual(
    spawned.map((s) => s.state.closed),
    [true, true]
  )
})

test("a close that throws does not abort the sweep", async () => {
  const p = createWarmPool({
    startup: async () => ({
      query() {},
      close() {
        throw new Error("already dead")
      },
    }),
  })
  await p.prewarm(send(), {})
  p.closeAll()
  assert.equal(p.size, 0)
})

test("the default capacity is small — each entry is a real process", () => {
  assert.ok(DEFAULT_WARM_CAPACITY <= 4)
})

// ---- verification --------------------------------------------------------------

test("claimedWarmSpare reads the SDK's own signal", () => {
  // A claim that silently fell back to a cold spawn is invisible from our
  // side, so this is the only honest way to verify the pool worked.
  assert.equal(claimedWarmSpare({ warm_spare_claimed: true }), true)
  assert.equal(claimedWarmSpare({ warm_spare_claimed: false }), false)
  assert.equal(claimedWarmSpare({}), false)
  assert.equal(claimedWarmSpare(undefined), false)
})

// ---- wiring ------------------------------------------------------------------

test("the dispatcher actually claims and refills the pool", async () => {
  // This repo's most recurrent defect is a fully-built feature nothing calls.
  // A source-level check is blunt, but it is the only thing that fails the day
  // someone removes the two call sites — the unit tests above would all still
  // pass against a pool nobody uses.
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "anthropic.mjs"),
    "utf8"
  )
  assert.match(source, /warmPool\(/, "the dispatcher must build the pool")
  assert.match(source, /pool\.claim\(sendOptions\)/, "a send must try to claim a warm subprocess")
  assert.match(source, /pool\.prewarm\(sendOptions/, "a send must refill the pool for the next one")
})

test("the host closes the pool on exit", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "agent-host.mjs"),
    "utf8"
  )
  assert.match(source, /resetWarmPool\(\)/, "warm subprocesses would outlive the host")
})
