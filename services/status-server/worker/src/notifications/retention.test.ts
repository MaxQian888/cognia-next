import { beforeEach, describe, expect, it } from "vitest"

import { T0, baseEnv, count, jobAt, resetOwnerE, stealLease } from "../admin/test-support"
import { runNotificationRetention } from "./index"

const DAY = 86_400_000

async function row(id: string, state: string, updatedAt: number): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO outbox (id, subscriber_id, event_id, channel, purpose, consent_version, state, attempts, subject,
       text_body, html_body, payload_digest, created_at, updated_at)
     VALUES (?, 'sub', 'evt_' || ?, 'email', 'notification', 1, ?, 1, 's', 't', 'h', 'd', ?, ?)`
  )
    .bind(id, id, state, updatedAt, updatedAt)
    .run()
}

describe("runNotificationRetention", () => {
  beforeEach(async () => {
    await resetOwnerE()
  })

  it("clears finished bodies after a day and deletes old metadata, keeping in-flight rows", async () => {
    await row("accepted_old", "provider_accepted", T0 - 2 * DAY)
    await row("accepted_new", "provider_accepted", T0 - 60_000)
    await row("uncertain_old", "uncertain", T0 - 2 * DAY)
    await row("ancient", "terminal_failure", T0 - 31 * DAY)
    await row("pending_ancient", "pending", T0 - 31 * DAY)
    await baseEnv.DB.prepare(
      "INSERT INTO notification_events (id, kind, payload_json, created_at, fanout_done) VALUES ('evt_gone', 'incident.opened', '{}', ?, 1)"
    )
      .bind(T0 - 31 * DAY)
      .run()
    await baseEnv.DB.prepare(
      "INSERT INTO operator_alerts (key, severity, last_sent_at) VALUES ('old', 'warning', ?)"
    )
      .bind(T0 - 31 * DAY)
      .run()

    const job = await jobAt("retention", T0)
    await runNotificationRetention(job)

    expect(
      await count("outbox", "id = 'accepted_old' AND text_body IS NULL AND subject IS NULL")
    ).toBe(1)
    expect(await count("outbox", "id = 'accepted_new' AND text_body IS NOT NULL")).toBe(1)
    expect(await count("outbox", "id = 'uncertain_old' AND text_body IS NOT NULL")).toBe(1)
    expect(await count("outbox", "id = 'ancient'")).toBe(0)
    expect(await count("outbox", "id = 'pending_ancient'")).toBe(1)
    expect(await count("notification_events")).toBe(0)
    expect(await count("operator_alerts")).toBe(0)
  })

  it("does nothing without the lease", async () => {
    await row("accepted_old", "provider_accepted", T0 - 2 * DAY)
    const job = await jobAt("retention", T0)
    await stealLease(job.lease)
    await runNotificationRetention(job)
    expect(await count("outbox", "text_body IS NOT NULL")).toBe(1)
  })
})
