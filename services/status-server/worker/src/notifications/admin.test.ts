import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { DeliveryView } from "../../../../../lib/status/contract"
import { resetAccessKeyCache } from "../admin/access"
import { handleAdminRoutes } from "../admin"
import {
  T0,
  accessKeys,
  adminCall,
  baseEnv,
  count,
  jwksFetch,
  operationId,
  readJson,
  resetOwnerE,
  seedSubscriber,
  type AccessKeys,
} from "../admin/test-support"

let keys: AccessKeys

beforeAll(async () => {
  keys = await accessKeys("delivery-kid")
})

async function insertRow(id: string, state: string, body: string | null = "text"): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO outbox (id, subscriber_id, event_id, channel, purpose, consent_version, state, attempts,
       next_attempt_at, attempt_started_at, subject, text_body, html_body, payload_digest, last_error_code,
       created_at, updated_at)
     VALUES (?, 'sub_a', 'incident-update:' || ?, 'email', 'notification', 1, ?, 1, NULL, ?, 'subj', ?, ?, 'digest', 'E_X', ?, ?)`
  )
    .bind(id, id, state, T0, body, body, T0, T0)
    .run()
}

describe("admin delivery routes", () => {
  beforeEach(async () => {
    await resetOwnerE()
    resetAccessKeyCache()
    vi.spyOn(globalThis, "fetch").mockImplementation(jwksFetch([keys]))
    await seedSubscriber("sub_a", "confirmed")
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("lists deliveries without recipients or bodies and filters by state", async () => {
    await insertRow("out_1", "uncertain")
    await insertRow("out_2", "provider_accepted")
    const response = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "GET",
      path: "/admin/delivery?state=uncertain",
    })
    const body = await readJson<{ deliveries: DeliveryView[] }>(response)
    expect(body.deliveries.map((row) => row.id)).toEqual(["out_1"])
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("example.com")
    expect(raw).not.toContain("subj")
    expect(
      (
        await adminCall(handleAdminRoutes, {
          keys,
          nowMs: T0,
          method: "GET",
          path: "/admin/delivery?state=delivered",
        })
      ).status
    ).toBe(400)
    expect(
      (
        await adminCall(handleAdminRoutes, {
          keys,
          nowMs: T0,
          method: "GET",
          path: "/admin/delivery?limit=500",
        })
      ).status
    ).toBe(400)
  })

  it("requires an explicit acknowledgement before retrying an uncertain send, and audits it", async () => {
    await insertRow("out_1", "uncertain")
    const unacknowledged = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "POST",
      path: "/admin/delivery/retry",
      body: { operationId: operationId("retry"), outboxId: "out_1", acknowledgeUncertain: false },
    })
    expect(unacknowledged.status).toBe(400)
    expect(await count("outbox", "state = 'uncertain'")).toBe(1)

    const acknowledged = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + 1_000,
      method: "POST",
      path: "/admin/delivery/retry",
      body: { operationId: operationId("retry"), outboxId: "out_1", acknowledgeUncertain: true },
    })
    expect(acknowledged.status).toBe(200)
    expect((await readJson<{ delivery: DeliveryView }>(acknowledged)).delivery).toMatchObject({
      id: "out_1",
      state: "pending",
    })
    expect(await count("outbox", "state = 'pending' AND attempt_started_at IS NULL")).toBe(1)
    const audit = await baseEnv.DB.prepare(
      "SELECT actor, detail_json FROM audit_events WHERE action = 'delivery.retry'"
    ).first<{ actor: string; detail_json: string }>()
    expect(audit!.actor).toBe("operator@cognia.test")
    expect(JSON.parse(audit!.detail_json)).toMatchObject({
      previousState: "uncertain",
      acknowledgeUncertain: true,
    })
  })

  it("refuses retries of accepted, unknown or purged rows", async () => {
    await insertRow("out_ok", "provider_accepted")
    await insertRow("out_purged", "terminal_failure", null)
    const call = (outboxId: string) =>
      adminCall(handleAdminRoutes, {
        keys,
        nowMs: T0,
        method: "POST",
        path: "/admin/delivery/retry",
        body: { operationId: operationId("retry"), outboxId, acknowledgeUncertain: true },
      })
    expect((await call("out_ok")).status).toBe(409)
    expect((await call("out_purged")).status).toBe(409)
    expect((await call("out_missing")).status).toBe(404)
    expect(await count("audit_events")).toBe(0)
  })
})
