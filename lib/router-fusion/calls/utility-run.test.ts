/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { fakeCompiledConfig, fixtureRouteRequest, routeAction } from "@cognia/router-fusion"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { RouterFusionInfrastructureError } from "../gate/faults"
import type { PreparedUtilityCall } from "./utility-route"
import { beginUtilityCall, type UtilityCallBinding } from "./utility-run"

const USD = 1_000_000
const config = fakeCompiledConfig()
let dbCounter = 0

function harness() {
  const name = `fusion-utility-test-${++dbCounter}`
  const db = new FusionDB(name)
  const store = new FusionLedgerStore({ db, codec: fusionContentCodec(name) })
  return { db, store }
}

function preparedRoute(overrides: Partial<PreparedUtilityCall> = {}): PreparedUtilityCall {
  const { decision } = routeAction(
    config,
    fixtureRouteRequest({ runId: "route-run", decisionId: "route-decision" })
  )
  return {
    decision,
    config,
    actionId: "direct_economy",
    deploymentId: "fake-economy",
    roleDeployments: { solver: "fake-economy" },
    dataClass: "internal",
    capMicrousd: 1 * USD,
    reserveMicrousd: 10_000,
    maxModelCalls: 4,
    deadlineMs: 600_000,
    budgetMode: "tracked",
    unknownPriceCallReserveMicrousd: 10_000,
    maxOutputTokens: 512,
    priceKnown: true,
    liveRefusal: () => null,
    ...overrides,
  }
}

const BINDING: UtilityCallBinding = {
  surface: "utilityLedger",
  origin: "utility",
  featureId: "conversation-title",
  requestDigestInput: "title|openai::gpt-5-mini|summarize this",
}

function deps(store: FusionLedgerStore, tenantLimit: number | null = null) {
  return {
    store: async () => store,
    leaseOwner: "window:test",
    tenantLimitRemainingMicrousd: tenantLimit,
  }
}

async function granted(
  store: FusionLedgerStore,
  route = preparedRoute(),
  limit: number | null = null
) {
  const started = await beginUtilityCall(deps(store, limit), route, BINDING)
  if (started.kind !== "granted") throw new Error(`refused: ${started.code}`)
  return started.handle
}

describe("beginUtilityCall", () => {
  it("[ACC:BUD-01] opens a session-less run, reserves the call and seals it when it succeeds", async () => {
    const { db, store } = harness()
    const handle = await granted(store)
    const run = await store.getRun(handle.runId)
    expect(run?.sessionId).toBeNull()
    expect(run?.origin).toBe("utility")
    expect(run?.surface).toBe("utilityLedger")
    expect(run?.status).toBe("running")
    // A utility call must never make the session it belongs to look busy.
    expect(await db.fusionSessionLocks.count()).toBe(0)

    const attempt = (await db.fusionCallAttempts.toArray())[0]
    expect(attempt).toMatchObject({
      logicalStepId: "utility:conversation-title",
      role: "solver",
      deploymentId: "fake-economy",
      state: "DISPATCHED",
    })

    await handle.succeeded({ inputTokens: 1_000, outputTokens: 100 })
    expect((await store.getRun(handle.runId))?.status).toBe("succeeded")
    expect((await db.fusionCallAttempts.get(attempt.attemptId))?.state).toBe("SUCCEEDED")
    expect(store.runAvailable((await store.getRun(handle.runId))!)).toBeGreaterThanOrEqual(0)
  })

  it("books each outcome once, however often the client reports it", async () => {
    const { db, store } = harness()
    const handle = await granted(store)
    await handle.succeeded({ inputTokens: 10, outputTokens: 10 })
    await handle.succeeded({ inputTokens: 999_999, outputTokens: 999_999 })
    await handle.failed("server_error")
    expect(await db.fusionLedger.where("kind").equals("settle").count()).toBe(1)
  })

  it("[ACC:BUD-05] refuses the call when the tenant has no allowance left, and opens no run", async () => {
    const { db, store } = harness()
    const started = await beginUtilityCall(deps(store, 1), preparedRoute(), BINDING)
    expect(started).toMatchObject({ kind: "refused" })
    expect(await db.fusionRuns.count()).toBe(0)
  })

  it("[ACC:AUTH-07] refuses — and seals the run — when policy changed since routing", async () => {
    const { store } = harness()
    const started = await beginUtilityCall(
      deps(store),
      preparedRoute({ liveRefusal: () => "PROVIDER_UNAVAILABLE" }),
      BINDING
    )
    expect(started).toMatchObject({ kind: "refused", code: "PROVIDER_UNAVAILABLE" })
    const run = (await store.db.fusionRuns.toArray())[0]
    expect(run.status).toBe("failed")
    expect(run.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    // Nothing was reserved, so nothing is still held against the tenant.
    expect((await store.getAccount()).activeHoldsMicrousd).toBe(0)
  })

  it("books a provider failure at its class and seals the run failed", async () => {
    const { db, store } = harness()
    const handle = await granted(store)
    await handle.failed("rate_limited")
    const attempt = (await db.fusionCallAttempts.toArray())[0]
    expect(attempt.state).toBe("FAILED")
    expect(attempt.errorClass).toBe("rate_limited")
    expect((await store.getRun(handle.runId))?.status).toBe("failed")
  })

  it("[ACC:BUD-06] keeps the money held for a call that was sent with no answer", async () => {
    const { db, store } = harness()
    const handle = await granted(store)
    await handle.unknown("aborted_before_answer")
    const attempt = (await db.fusionCallAttempts.toArray())[0]
    expect(attempt.state).toBe("UNKNOWN")
    expect(attempt.unknownReason).toBe("aborted_before_answer")
    const run = await store.getRun(handle.runId)
    expect(run?.status).toBe("failed")
    expect(run?.error).toMatchObject({ code: "CALL_OUTCOME_UNKNOWN" })
    // An uncertain call pins its reservation against the tenant (BUD-07).
    expect((await store.getAccount()).activeHoldsMicrousd).toBeGreaterThan(0)
    expect(await db.fusionLedger.where("kind").equals("unknown").count()).toBe(1)
  })

  it("cancels rather than fails when the caller aborted", async () => {
    const { store } = harness()
    const handle = await granted(store)
    await handle.failed("cancelled")
    expect((await store.getRun(handle.runId))?.status).toBe("cancelled")
  })

  it("reports a lease it cannot take as an infrastructure fault, not a refusal", async () => {
    const { store } = harness()
    const broken = {
      createRun: store.createRun.bind(store),
      acquireLease: async () => ({ ok: false as const, code: "LEASE_HELD" as const }),
    } as unknown as FusionLedgerStore
    await expect(beginUtilityCall(deps(broken), preparedRoute(), BINDING)).rejects.toBeInstanceOf(
      RouterFusionInfrastructureError
    )
  })
})
