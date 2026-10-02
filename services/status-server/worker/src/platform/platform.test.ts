import { beforeEach, describe, expect, it } from "vitest"

import { resetCore, testEnv } from "../../test/helpers"
import { errorResponse, json, readBoundedBody, readJsonBody } from "./http"
import { acquireLease, leaseGuard, leaseHeld, releaseLease, withLease } from "./lease"
import {
  auditStatement,
  findOperation,
  nextCounter,
  readCounter,
  recordOperationStatement,
} from "./store"

const db = () => testEnv.DB

beforeEach(async () => {
  await resetCore()
})

describe("http envelope", () => {
  it("returns the JSON error envelope with security headers", async () => {
    const response = errorResponse(
      "revision_conflict",
      { requestId: "req-1" },
      { currentRevision: 3 }
    )
    expect(response.status).toBe(409)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({
      code: "revision_conflict",
      requestId: "req-1",
      currentRevision: 3,
    })
  })

  it("adds credentials-free CORS only to public reads", () => {
    expect(json({}, { publicRead: true }).headers.get("access-control-allow-origin")).toBe("*")
    expect(json({}).headers.get("access-control-allow-origin")).toBeNull()
  })

  it("bounds request bodies by declared and actual size", async () => {
    const declared = new Request("https://x.test", {
      method: "POST",
      body: "a",
      headers: { "content-length": "999999" },
    })
    await expect(readBoundedBody(declared, 10)).resolves.toEqual({
      ok: false,
      code: "body_too_large",
    })
    const streamed = new Request("https://x.test", { method: "POST", body: "a".repeat(20) })
    await expect(readBoundedBody(streamed, 10)).resolves.toEqual({
      ok: false,
      code: "body_too_large",
    })
    const invalid = new Request("https://x.test", {
      method: "POST",
      body: new Uint8Array([0xff, 0xfe]),
    })
    await expect(readBoundedBody(invalid, 10)).resolves.toEqual({ ok: false, code: "bad_request" })
    const good = new Request("https://x.test", { method: "POST", body: '{"a":1}' })
    await expect(readJsonBody(good)).resolves.toMatchObject({ ok: true, value: { a: 1 } })
    const malformed = new Request("https://x.test", { method: "POST", body: "{" })
    await expect(readJsonBody(malformed)).resolves.toEqual({ ok: false, code: "bad_request" })
  })
})

describe("leases", () => {
  it("grants one holder at a time and increments the fence", async () => {
    const now = 1_000_000
    const first = await acquireLease(db(), "aggregate", now)
    expect(first?.fence).toBe(1)
    expect(await acquireLease(db(), "aggregate", now + 1)).toBeNull()
    await releaseLease(db(), first!)
    const second = await acquireLease(db(), "aggregate", now + 2)
    expect(second?.fence).toBe(2)
  })

  it("lets a new runner take an expired lease and fences out the old one", async () => {
    const now = 1_000_000
    const stale = (await acquireLease(db(), "delivery", now, 1_000))!
    const fresh = (await acquireLease(db(), "delivery", now + 1_000, 1_000))!
    expect(fresh.fence).toBe(stale.fence + 1)
    expect(await leaseHeld(db(), stale, now + 1_001)).toBe(false)
    expect(await leaseHeld(db(), fresh, now + 1_001)).toBe(true)
    // A stale release cannot free the new holder's lease.
    await releaseLease(db(), stale)
    expect(await leaseHeld(db(), fresh, now + 1_002)).toBe(true)
    const guard = leaseGuard(stale, now + 1_001)
    const write = await db()
      .prepare(`UPDATE counters SET value = 99 WHERE name = 'dirty_seq' AND ${guard.sql}`)
      .bind(...guard.params)
      .run()
    expect(write.meta.changes).toBe(0)
  })

  it("creates rows for unseeded jobs and releases after work throws", async () => {
    await expect(
      withLease(db(), "custom-job", 5_000, async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(await acquireLease(db(), "custom-job", 5_001)).not.toBeNull()
  })
})

describe("store helpers", () => {
  it("increments named counters monotonically", async () => {
    expect(await nextCounter(db(), "snapshot_revision")).toBe(1)
    expect(await nextCounter(db(), "snapshot_revision")).toBe(2)
    expect(await nextCounter(db(), "brand_new")).toBe(1)
    expect(await readCounter(db(), "snapshot_revision")).toBe(2)
  })

  it("replays an operation only for the same request bytes", async () => {
    const bytes = new TextEncoder().encode('{"x":1}')
    await (
      await recordOperationStatement(db(), {
        operationId: "op_1",
        actor: "operator",
        kind: "incident.create",
        requestBytes: bytes,
        status: 201,
        response: { id: "inc_1" },
        atMs: 1,
      })
    ).run()
    await expect(findOperation(db(), "op_1", bytes)).resolves.toEqual({
      status: 201,
      response: { id: "inc_1" },
      sameRequest: true,
    })
    await expect(
      findOperation(db(), "op_1", new TextEncoder().encode('{"x":2}'))
    ).resolves.toMatchObject({ sameRequest: false })
    await expect(findOperation(db(), "op_missing", bytes)).resolves.toBeNull()
  })

  it("writes a conditional audit row only when the previous statement changed a row", async () => {
    const entry = {
      atMs: 1,
      actor: "op",
      action: "x",
      targetType: "t",
      targetId: null,
      revision: null,
    }
    await db().batch([
      db().prepare("UPDATE counters SET value = 5 WHERE name = 'does-not-exist'"),
      auditStatement(db(), entry, { onlyIfPreviousChanged: true }),
      db().prepare("UPDATE counters SET value = 5 WHERE name = 'dirty_seq'"),
      auditStatement(db(), { ...entry, action: "y" }, { onlyIfPreviousChanged: true }),
    ])
    const rows = await db().prepare("SELECT action FROM audit_events").all()
    expect(rows.results).toEqual([{ action: "y" }])
  })
})
