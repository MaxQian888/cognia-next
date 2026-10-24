import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  hostStateAction,
  parsePersons,
  partitionAccountId,
  signalingRelay,
  smokeFailureCount,
  waitForBrainReady,
} from "./compose-smoke.mjs"

test("waits for required readiness even after bridge hello and tolerates optional degradation", async (t) => {
  const responses = [
    new Response(JSON.stringify({ status: "not_ready", checks: { bootstrapped: false } }), {
      status: 503,
    }),
    new Response(
      JSON.stringify({ status: "not_ready", checks: { failedRequiredRuntimes: ["scheduler"] } }),
      { status: 503 }
    ),
    new Response(
      JSON.stringify({ status: "ready", degraded: true, failedRuntimes: ["backup-scheduler"] })
    ),
  ]
  const urls = []
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url)
    return responses.shift()
  })
  const ready = await waitForBrainReady({ tries: 3, intervalMs: 0 })
  assert.equal(ready.degraded, true)
  assert.equal(urls.length, 3)
  assert.ok(urls.every((url) => url.endsWith("/readyz")))
})

test("fails smoke with required runtime diagnostics when readiness never recovers", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "not_ready",
          checks: { failedRequiredRuntimes: ["scheduler"] },
        }),
        { status: 503 }
      )
  )
  await assert.rejects(waitForBrainReady({ tries: 1, intervalMs: 0 }), /scheduler/)
})

test("readiness probes cannot restart a healthy server process", () => {
  const kube = readFileSync(
    new URL("../../deploy/k8s/base/cognia-server.yaml", import.meta.url),
    "utf8"
  )
  for (const probe of ["startupProbe", "livenessProbe"]) {
    assert.match(kube, new RegExp(`${probe}:\\s+httpGet:\\s+path: /livez`))
  }
  assert.match(kube, /readinessProbe:\s+httpGet:\s+path: \/readyz/)
  for (const file of [
    "docker-compose.yml",
    "docker-compose.web-headless-e2e.yml",
    "compose.production.yaml",
  ]) {
    const compose = readFileSync(new URL(`../../deploy/compose/${file}`, import.meta.url), "utf8")
    assert.ok(compose.includes("https://localhost:27890/readyz"), file)
    assert.ok(!compose.includes("https://localhost:27890/healthz"), file)
    assert.ok(!compose.includes("autoheal"), file)
  }
})

test("signaling relay observes both sockets opening in the same event-loop turn", async (t) => {
  const originalWebSocket = globalThis.WebSocket
  const clients = []
  const failuresBefore = smokeFailureCount()
  t.after(() => {
    globalThis.WebSocket = originalWebSocket
  })
  globalThis.WebSocket = class extends EventTarget {
    closed = false

    constructor() {
      super()
      clients.push(this)
      queueMicrotask(() => {
        this.dispatchEvent(new Event("open"))
        this.receive({ kind: "challenge", challenge: "test-challenge" })
      })
    }

    receive(frame) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }))
    }

    send(raw) {
      const frame = JSON.parse(raw)
      if (frame.kind === "subscribe") this.receive({ kind: "subscribed" })
      if (frame.kind === "relay") {
        clients.find((client) => client !== this).receive(frame)
      }
    }

    close() {
      this.closed = true
    }
  }

  let timer
  try {
    await Promise.race([
      signalingRelay(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("relay missed an open event after both sockets opened")),
          1000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  assert.equal(clients.length, 2)
  assert.ok(clients.every((client) => client.closed))
  assert.equal(smokeFailureCount(), failuresBefore)
})

test("persons tier derives the Host's partition account id", () => {
  // The vector pinned by p5_partition_identity_and_task_local_are_not_caller_args.
  assert.equal(partitionAccountId("org", "user"), "pb_693259bd42dbe0fbdd073e21")
  assert.notEqual(partitionAccountId("orgu", "ser"), partitionAccountId("org", "user"))
})

test("persons tier takes exactly two subject:userId people", () => {
  assert.deepEqual(parsePersons("a:usr_a, b:usr_b"), [
    { subject: "a", userId: "usr_a" },
    { subject: "b", userId: "usr_b" },
  ])
  assert.throws(() => parsePersons("a:usr_a"), /exactly two/)
  assert.throws(() => parsePersons("a,b:usr_b"), /subject:userId/)
})

test("persons tier addresses each HostState action to its session channel", () => {
  const scope = { accountId: "pb_1", runtimeTargetId: "target/1" }
  const action = hostStateAction(scope, { hostId: "h", hostGeneration: 3 }, "s 1", 2, {
    kind: "session.create",
  })
  assert.equal(action.channel, "cognia://target/target%2F1/sessions/s%201")
  assert.equal(action.accountId, "pb_1")
  assert.equal(action.hostGeneration, 3)
  assert.equal(action.clientSeq, 2)
  assert.match(action.actionId, /^[0-9a-f-]{36}$/)
  assert.equal("baseRevision" in action, false)
  assert.equal(
    hostStateAction(scope, { hostId: "h", hostGeneration: 3 }, "s", 3, {}, 1).baseRevision,
    1
  )
})
