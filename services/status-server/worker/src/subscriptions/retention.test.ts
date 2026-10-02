import { beforeEach, describe, expect, it } from "vitest"

import { bytesToBase64Url } from "../../../../../lib/status/signing"
import { T0, MINUTE, baseEnv, count, jobAt, resetOwnerE, stealLease } from "../admin/test-support"
import type { Env } from "../env"
import { emailHmacs, encKeyRing, encryptEmail, hmacKeyRing } from "./keys"
import { runSubscriptionRetention } from "./index"

const DAY = 24 * 60 * MINUTE

async function insertSubscriber(
  id: string,
  state: string,
  extra: { pendingSince?: number | null; purgeAfter?: number | null; email?: string } = {}
): Promise<void> {
  const email = extra.email ?? `${id}@example.com`
  const [hmac] = await emailHmacs(hmacKeyRing(baseEnv)!, email)
  const sealed = await encryptEmail(encKeyRing(baseEnv)!, id, email)
  await baseEnv.DB.prepare(
    `INSERT INTO subscribers (id, email_hmac, email_hmac_key_id, email_ciphertext, email_key_id, state, locale,
       component_ids_json, consent_version, consent_terms_version, preference_revision, created_at, pending_since,
       confirmed_at, updated_at, last_confirmation_sent_at, suppressed_reason, purge_after, write_token)
     VALUES (?, ?, ?, ?, ?, ?, 'en', '["relayData"]', 1, 1, 0, ?, ?, NULL, ?, NULL, NULL, ?, NULL)`
  )
    .bind(
      id,
      hmac!.hmac,
      hmac!.keyId,
      sealed.ciphertext,
      sealed.keyId,
      state,
      T0,
      extra.pendingSince ?? null,
      T0,
      extra.purgeAfter ?? null
    )
    .run()
  await baseEnv.DB.prepare(
    `INSERT INTO subscriber_tokens (token_hash, subscriber_id, purpose, consent_version, preference_revision, created_at, expires_at)
     VALUES (?, ?, 'manage', 1, 0, ?, ?)`
  )
    .bind(`hash-${id}`, id, T0, T0 + 400 * DAY)
    .run()
}

async function retentionAt(nowMs: number, env: Env = baseEnv): Promise<void> {
  const job = await jobAt("retention", nowMs, env)
  await runSubscriptionRetention(job)
  await baseEnv.DB.prepare(
    "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'retention'"
  ).run()
}

describe("runSubscriptionRetention", () => {
  beforeEach(async () => {
    await resetOwnerE()
  })

  it("deletes expired pending entries, purges unsubscribed ones and reduces suppressed ones", async () => {
    await insertSubscriber("sub_fresh", "pending", { pendingSince: T0 })
    await insertSubscriber("sub_stale", "pending", { pendingSince: T0 - 2 * DAY })
    await insertSubscriber("sub_gone", "unsubscribed", { purgeAfter: T0 - MINUTE })
    await insertSubscriber("sub_waiting", "unsubscribed", { purgeAfter: T0 + DAY })
    await insertSubscriber("sub_bounced", "suppressed", { purgeAfter: T0 - MINUTE })
    await baseEnv.DB.prepare(
      `INSERT INTO outbox (id, subscriber_id, event_id, channel, purpose, consent_version, state, attempts,
         next_attempt_at, subject, text_body, html_body, payload_digest, created_at, updated_at)
       VALUES ('out_stale', 'sub_stale', 'evt', 'email', 'confirmation', 1, 'pending', 0, ?, 's', 't', 'h', 'd', ?, ?)`
    )
      .bind(T0, T0, T0)
      .run()
    await baseEnv.DB.prepare(
      "INSERT INTO rate_buckets (bucket, count, expires_at) VALUES ('ip:x:1', 3, ?)"
    )
      .bind(T0 - 2 * 60 * MINUTE)
      .run()

    await retentionAt(T0)

    const remaining = await baseEnv.DB.prepare(
      "SELECT id, email_ciphertext FROM subscribers ORDER BY id"
    ).all<{ id: string; email_ciphertext: string | null }>()
    expect(remaining.results.map((row) => row.id)).toEqual([
      "sub_bounced",
      "sub_fresh",
      "sub_waiting",
    ])
    // The suppression record keeps only its HMAC index.
    expect(remaining.results.find((row) => row.id === "sub_bounced")!.email_ciphertext).toBeNull()
    expect(await count("subscriber_tokens", "subscriber_id IN ('sub_stale', 'sub_gone')")).toBe(0)
    expect(
      await count("outbox", "id = 'out_stale' AND state = 'cancelled' AND text_body IS NULL")
    ).toBe(1)
    expect(await count("rate_buckets")).toBe(0)
  })

  it("re-keys rows sealed under an older key", async () => {
    await insertSubscriber("sub_old", "confirmed", { email: "rotate@example.com" })
    const fresh = () => {
      const bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      return bytesToBase64Url(bytes)
    }
    const rotated: Env = {
      ...baseEnv,
      SUBSCRIBER_HMAC_KEYS: JSON.stringify({
        ...JSON.parse(baseEnv.SUBSCRIBER_HMAC_KEYS!),
        h2: fresh(),
      }),
      SUBSCRIBER_HMAC_KEY_ID: "h2",
      SUBSCRIBER_ENC_KEYS: JSON.stringify({
        ...JSON.parse(baseEnv.SUBSCRIBER_ENC_KEYS!),
        e2: fresh(),
      }),
      SUBSCRIBER_ENC_KEY_ID: "e2",
    }
    await retentionAt(T0, rotated)
    const row = await baseEnv.DB.prepare(
      "SELECT email_hmac, email_hmac_key_id, email_key_id FROM subscribers"
    ).first<Record<string, string>>()
    expect(row).toMatchObject({ email_hmac_key_id: "h2", email_key_id: "e2" })
    const [expected] = await emailHmacs(hmacKeyRing(rotated)!, "rotate@example.com")
    expect(row!.email_hmac).toBe(expected!.hmac)
  })

  it("changes nothing without the lease", async () => {
    await insertSubscriber("sub_stale", "pending", { pendingSince: T0 - 2 * DAY })
    const job = await jobAt("retention", T0)
    await stealLease(job.lease)
    await runSubscriptionRetention(job)
    expect(await count("subscribers")).toBe(1)
  })
})
