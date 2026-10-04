import assert from "node:assert/strict"
import { test } from "node:test"

import { getCurrentClaim, inspectDelivery, receiptName } from "./ledger.mjs"

const key = "feishu-v1-0123456789abcdef0123456789abcdef"
const repository = "acme/cognia"
const input = { key, repository }
const run = (id, extra = {}) => ({
  id,
  path: ".github/workflows/feishu-notify.yml@refs/heads/main",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  event: "workflow_run",
  ...extra,
})
const artifact = (id, name, runId = 10, extra = {}) => ({
  id,
  name,
  workflow_run: { id: runId },
  expired: false,
  created_at: "2026-10-03T00:00:00Z",
  ...extra,
})

function client(artifacts = [], runs = [run(10)]) {
  const calls = []
  return {
    calls,
    async listArtifacts({ name, runId } = {}) {
      calls.push(["listArtifacts", name, runId])
      return artifacts.filter(
        (item) =>
          (!name || item.name === name) &&
          (!runId || String(item.workflow_run?.id) === String(runId))
      )
    },
    async getRun(id) {
      calls.push(["getRun", id])
      const found = runs.find((item) => String(item.id) === String(id))
      if (!found) throw new Error("Bearer sensitive-token")
      return found
    },
  }
}

test("new delivery has no trusted claim or acceptance", async () => {
  assert.deepEqual(await inspectDelivery(client(), input), { status: "new" })
})

test("trusted accepted receipt is terminal; expired receipts are ignored", async () => {
  assert.deepEqual(await inspectDelivery(client([artifact(1, `${key}-accepted`)]), input), {
    status: "accepted",
  })
  assert.deepEqual(
    await inspectDelivery(client([artifact(1, `${key}-accepted`, 10, { expired: true })]), input),
    { status: "new" }
  )
})

test("does not trust forged PR, foreign repository, head repository or workflow receipts", async () => {
  for (const extra of [
    { event: "pull_request" },
    { event: "pull_request_target" },
    { repository: { full_name: "other/cognia" } },
    { head_repository: { full_name: "fork/cognia" } },
    { path: ".github/workflows/ci.yml" },
    { path: "other/.github/workflows/feishu-notify.yml" },
    { head_repository: null },
  ]) {
    const api = client(
      [artifact(1, `${key}-accepted`), artifact(2, `${key}-claim`)],
      [run(10, extra)]
    )
    assert.deepEqual(await inspectDelivery(api, input), { status: "new" })
    assert.equal(api.calls.filter(([method]) => method === "getRun").length, 1)
  }
})

test("a pending claim blocks automatic resend regardless of run conclusion", async () => {
  const claim = artifact(7, `${key}-claim`)
  const api = client([claim], [run(10, { conclusion: "failure" })])
  assert.deepEqual(await inspectDelivery(api, input), { status: "delivery-unknown", claim })
})

test("only safe refusal bound to latest claim authorizes a retry", async () => {
  const older = artifact(7, `${key}-claim`, 10)
  const latest = artifact(8, `${key}-claim`, 11, { created_at: "2026-10-03T00:01:00Z" })
  const earlierRejection = artifact(9, `${key}-rejected-7`, 10)
  const api = client([older, latest, earlierRejection], [run(10), run(11)])
  assert.deepEqual(await inspectDelivery(api, input), { status: "delivery-unknown", claim: latest })
  for (const outcome of [
    "rejected",
    "rate-limited",
    "auth-failed",
    "invalid-target",
    "superseded",
  ]) {
    const refusal = artifact(12, `${key}-${outcome}-8`, 11)
    assert.deepEqual(
      await inspectDelivery(
        client([older, latest, earlierRejection, refusal], [run(10), run(11)]),
        input
      ),
      { status: "retryable", claim: latest }
    )
  }
})

test("does not accept stale, expired, unknown or other-run refusal evidence", async () => {
  const claim = artifact(8, `${key}-claim`)
  for (const refusal of [
    artifact(9, `${key}-rejected-7`),
    artifact(9, `${key}-rejected-8`, 10, { expired: true }),
    artifact(9, `${key}-delivery-unknown-8`),
    artifact(9, `${key}-rejected-8`, 11),
  ]) {
    assert.deepEqual(await inspectDelivery(client([claim, refusal], [run(10), run(11)]), input), {
      status: "delivery-unknown",
      claim,
    })
  }
  assert.deepEqual(
    await inspectDelivery(
      client([claim, artifact(9, `${key}-rejected-8`), artifact(10, `${key}-delivery-unknown-8`)]),
      input
    ),
    { status: "delivery-unknown", claim }
  )
})

test("latest claim uses created_at then numeric artifact ID and caches owner lookup", async () => {
  const old = artifact(100, `${key}-claim`, 10, { created_at: "2026-10-02T00:00:00Z" })
  const latest = artifact(11, `${key}-claim`)
  const api = client([old, artifact(9, `${key}-claim`), latest, artifact(12, `${key}-rejected-11`)])
  assert.deepEqual(await inspectDelivery(api, input), { status: "retryable", claim: latest })
  assert.equal(api.calls.filter(([method]) => method === "getRun").length, 1)
})

test("getCurrentClaim selects the latest claim belonging to this reporter", async () => {
  const own = artifact(12, `${key}-claim`, 11)
  const api = client(
    [artifact(20, `${key}-claim`), artifact(11, `${key}-claim`, 11), own],
    [run(10), run(11, { event: "workflow_dispatch" })]
  )
  assert.deepEqual(await getCurrentClaim(api, { ...input, reporterRunId: 11 }), own)
  await assert.rejects(
    getCurrentClaim(api, { ...input, reporterRunId: 12 }),
    /^Error: Feishu delivery claim unavailable$/
  )
})

test("scheduled notifier claims are trusted and PR current claims fail closed", async () => {
  const claim = artifact(7, `${key}-claim`)
  assert.deepEqual(
    await getCurrentClaim(client([claim], [run(10, { event: "schedule" })]), {
      ...input,
      reporterRunId: 10,
    }),
    claim
  )
  await assert.rejects(
    getCurrentClaim(client([claim], [run(10, { event: "pull_request" })]), {
      ...input,
      reporterRunId: 10,
    }),
    /^Error: Feishu delivery claim unavailable$/
  )
})

test("API failures are safe errors, never an empty ledger", async () => {
  for (const api of [
    {
      listArtifacts: async () => {
        throw new Error("Bearer secret")
      },
    },
    client([artifact(1, `${key}-accepted`)], []),
    { listArtifacts: async () => null },
  ]) {
    await assert.rejects(inspectDelivery(api, input), /^Error: Feishu delivery ledger unavailable$/)
  }
  await assert.rejects(
    getCurrentClaim(
      {
        listArtifacts: async () => {
          throw new Error("Bearer secret")
        },
      },
      { ...input, reporterRunId: 10 }
    ),
    /^Error: Feishu delivery ledger unavailable$/
  )
})

test("receipt names bind non-accepted outcomes to a specific claim", () => {
  assert.equal(receiptName(key, "accepted", 42), `${key}-accepted`)
  assert.equal(receiptName(key, "rejected", 42), `${key}-rejected-42`)
  assert.equal(receiptName(key, "delivery-unknown", 42), `${key}-delivery-unknown-42`)
  assert.throws(() => receiptName(key, "surprise", 42), /^Error: Invalid Feishu delivery receipt$/)
  assert.throws(
    () => receiptName(key, "rejected", undefined),
    /^Error: Invalid Feishu delivery receipt$/
  )
})
