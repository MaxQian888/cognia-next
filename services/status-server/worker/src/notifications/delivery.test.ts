import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  T0,
  MINUTE,
  baseEnv,
  count,
  emailEnv,
  fakeEmail,
  jobAt,
  resetOwnerE,
  seedSubscriber,
  stealLease,
  type SentMail,
} from "../admin/test-support"
import type { Env } from "../env"
import { planCreateIncident } from "../incidents/store"
import { runDelivery } from "./index"

type Fake = ReturnType<typeof fakeEmail>

async function openIncident(
  atMs: number,
  componentIds: Array<"relayData" | "signalingHttp"> = ["relayData"]
): Promise<string> {
  const plan = planCreateIncident(baseEnv.DB, {
    title: { en: "Relay <b>down</b>", "zh-CN": "中继中断" },
    state: "investigating",
    impact: "major_outage",
    componentIds,
    source: "manual",
    fingerprint: null,
    pinned: true,
    manualOwner: "operator@cognia.test",
    predecessorId: null,
    update: {
      message: { en: "Investigating <script>x</script>" },
      source: "manual",
      atMs,
      evidenceAtMs: null,
      correctionOf: null,
    },
  })
  await baseEnv.DB.batch(plan.statements)
  return plan.incidentId
}

async function deliverAt(nowMs: number, env: Env): Promise<void> {
  const job = await jobAt("delivery", nowMs, env)
  await runDelivery(job)
  await baseEnv.DB.prepare(
    "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'delivery'"
  ).run()
}

async function outboxStates(): Promise<
  Array<{
    subscriber_id: string
    purpose: string
    state: string
    last_error_code: string | null
    provider_message_id: string | null
    attempts: number
  }>
> {
  const rows = await baseEnv.DB.prepare(
    "SELECT subscriber_id, purpose, state, last_error_code, provider_message_id, attempts FROM outbox ORDER BY subscriber_id, created_at"
  ).all<{
    subscriber_id: string
    purpose: string
    state: string
    last_error_code: string | null
    provider_message_id: string | null
    attempts: number
  }>()
  return rows.results
}

describe("runDelivery", () => {
  let email: Fake
  let env: Env

  beforeEach(async () => {
    await resetOwnerE()
    email = fakeEmail()
    env = emailEnv(email)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("fans an event out to matching confirmed subscribers once and sends rendered mail", async () => {
    await seedSubscriber("sub_all", "confirmed", { email: "All+tag@example.com" })
    await seedSubscriber("sub_relay", "confirmed", { componentIds: ["relayData"], locale: "zh-CN" })
    await seedSubscriber("sub_http", "confirmed", { componentIds: ["signalingHttp"] })
    await seedSubscriber("sub_pending", "pending")
    await seedSubscriber("sub_late", "confirmed", { confirmedAtMs: T0 + 30 * MINUTE })
    const incidentId = await openIncident(T0)

    await deliverAt(T0 + MINUTE, env)
    await deliverAt(T0 + 2 * MINUTE, env)

    expect(await count("outbox")).toBe(2)
    expect(email.sent.map((mail) => mail.to).sort()).toEqual([
      "All+tag@example.com",
      "sub_relay@example.com",
    ])
    const states = await outboxStates()
    expect(
      states.every((row) => row.state === "provider_accepted" && row.provider_message_id !== null)
    ).toBe(true)

    const english = email.sent.find((mail) => mail.to === "All+tag@example.com")!
    expect(english.subject).toBe("[Cognia Status] Investigating: Relay <b>down</b>")
    expect(english.text).toContain(`https://status.test/status/?incident=${incidentId}`)
    expect(english.text).toContain("#action=unsubscribe&token=")
    expect(english.html).toContain("Investigating &lt;script&gt;x&lt;/script&gt;")
    expect(english.html).not.toContain("<script>")
    expect(english.from).toEqual({ email: "status@cognia.test", name: "Cognia Status" })
    const chinese = email.sent.find((mail) => mail.to === "sub_relay@example.com")!
    expect(chinese.subject).toBe("[Cognia 状态] 调查中: 中继中断")
    // One manage token minted per created row, none for the replayed run.
    expect(await count("subscriber_tokens", "purpose = 'manage'")).toBe(2)
  })

  it("creates and sends nothing while email is unavailable; queued rows wait", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    await deliverAt(T0 + MINUTE, baseEnv)
    await deliverAt(T0 + MINUTE, { ...env, FEATURE_EMAIL: "off" })
    expect(await count("outbox")).toBe(0)
    await deliverAt(T0 + 2 * MINUTE, env)
    expect(email.sent).toHaveLength(1)
  })

  it("does not mail events older than a day when delivery resumes", async () => {
    await seedSubscriber("sub_a", "confirmed", { confirmedAtMs: T0 - 2 * 24 * 60 * MINUTE })
    await openIncident(T0 - 25 * 60 * MINUTE)
    await deliverAt(T0, env)
    expect(email.sent).toHaveLength(0)
    expect(await count("notification_events", "fanout_done = 1")).toBe(1)
  })

  it("backs off on provider rate limits and retries when due", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    email.behavior = { kind: "throw", code: "E_RATE_LIMIT_EXCEEDED" }
    await deliverAt(T0 + MINUTE, env)
    const row = await baseEnv.DB.prepare(
      "SELECT state, next_attempt_at, attempts FROM outbox"
    ).first<{ state: string; next_attempt_at: number; attempts: number }>()
    expect(row).toMatchObject({ state: "retryable_failure", attempts: 1 })
    expect(row!.next_attempt_at).toBeGreaterThanOrEqual(T0 + MINUTE + 48_000)
    expect(row!.next_attempt_at).toBeLessThanOrEqual(T0 + MINUTE + 72_000)

    email.behavior = { kind: "accept" }
    await deliverAt(T0 + MINUTE + 10_000, env)
    expect(email.sent).toHaveLength(1)
    await deliverAt(T0 + 3 * MINUTE, env)
    expect(email.sent).toHaveLength(2)
    expect((await outboxStates())[0]).toMatchObject({ state: "provider_accepted", attempts: 2 })
  })

  it("gives up on terminal provider errors", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    email.behavior = { kind: "throw", code: "E_SENDER_NOT_VERIFIED" }
    await deliverAt(T0 + MINUTE, env)
    await deliverAt(T0 + 10 * MINUTE, env)
    expect(email.sent).toHaveLength(1)
    expect((await outboxStates())[0]).toMatchObject({
      state: "terminal_failure",
      last_error_code: "E_SENDER_NOT_VERIFIED",
    })
  })

  it.each([
    [{ kind: "throw", code: "E_DELIVERY_FAILED" } as const, "E_DELIVERY_FAILED"],
    [{ kind: "throw", code: "E_INTERNAL_SERVER_ERROR" } as const, "E_INTERNAL_SERVER_ERROR"],
    [{ kind: "throw" } as const, "no_code"],
  ])("marks %j uncertain and never retries it automatically", async (behavior, code) => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    email.behavior = behavior
    await deliverAt(T0 + MINUTE, env)
    email.behavior = { kind: "accept" }
    await deliverAt(T0 + 3 * 60 * MINUTE, env)
    expect(email.sent).toHaveLength(1)
    expect((await outboxStates())[0]).toMatchObject({ state: "uncertain", last_error_code: code })
  })

  it("treats a provider timeout as uncertain", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(T0)
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    email.behavior = { kind: "hang" }
    const job = await jobAt("delivery", T0 + MINUTE, env)
    const running = runDelivery(job)
    await vi.advanceTimersByTimeAsync(16_000)
    await running
    expect((await outboxStates())[0]).toMatchObject({
      state: "uncertain",
      last_error_code: "timeout",
    })
  })

  it("suppresses the subscriber when the provider reports the recipient suppressed", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    await openIncident(T0 + 1)
    email.behavior = { kind: "throw", code: "E_RECIPIENT_SUPPRESSED" }
    await deliverAt(T0 + MINUTE, env)
    expect(email.sent).toHaveLength(1)
    const states = (await outboxStates()).map((row) => row.state).sort()
    expect(states).toEqual(["suppressed", "suppressed"])
    expect(
      await count(
        "subscribers",
        "state = 'suppressed' AND suppressed_reason = 'provider_suppressed' AND consent_version = 2"
      )
    ).toBe(1)
  })

  it("re-checks consent right before sending", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    // Fan out without sending (email binding answers later).
    const job = await jobAt("delivery", T0 + MINUTE, env)
    const { fanOutEvents } = await import("./fanout")
    await fanOutEvents(job)
    await baseEnv.DB.prepare(
      "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'delivery'"
    ).run()
    // Consent ends without the outbox being touched (e.g. a race).
    await baseEnv.DB.prepare(
      "UPDATE subscribers SET state = 'unsubscribed', consent_version = 2"
    ).run()
    await deliverAt(T0 + 2 * MINUTE, env)
    expect(email.sent).toHaveLength(0)
    expect((await outboxStates())[0]).toMatchObject({
      state: "cancelled",
      last_error_code: "consent_changed",
    })
  })

  it("documents the unsubscribe cutoff: a started send completes, unstarted ones are cancelled", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    await openIncident(T0 + 1)
    email.behavior = {
      kind: "custom",
      run: async (_mail: SentMail) => {
        // The subscriber unsubscribes while the first provider call is in flight.
        await baseEnv.DB.batch([
          baseEnv.DB.prepare(
            "UPDATE subscribers SET state = 'unsubscribed', consent_version = consent_version + 1"
          ),
          baseEnv.DB.prepare(
            `UPDATE outbox SET state = 'cancelled', last_error_code = 'unsubscribed'
             WHERE state IN ('pending', 'retryable_failure') OR (state = 'leased' AND attempt_started_at IS NULL)`
          ),
        ])
        return { messageId: "msg-in-flight" }
      },
    }
    await deliverAt(T0 + MINUTE, env)
    expect(email.sent).toHaveLength(1)
    const states = (await outboxStates()).map((row) => row.state).sort()
    expect(states).toEqual(["cancelled", "provider_accepted"])
  })

  it("lets a runner that lost its lease record nothing; the next runner marks the send uncertain", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    const job = await jobAt("delivery", T0 + MINUTE, env)
    email.behavior = {
      kind: "custom",
      run: async () => {
        await stealLease(job.lease)
        return { messageId: "msg-lost" }
      },
    }
    await runDelivery(job)
    expect(email.sent).toHaveLength(1)
    expect((await outboxStates())[0]).toMatchObject({ state: "leased", provider_message_id: null })

    await baseEnv.DB.prepare(
      "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'delivery'"
    ).run()
    email.behavior = { kind: "accept" }
    await deliverAt(T0 + 2 * MINUTE, env)
    expect(email.sent).toHaveLength(1)
    expect((await outboxStates())[0]).toMatchObject({
      state: "uncertain",
      last_error_code: "abandoned_attempt",
    })
  })

  it("returns rows a crashed runner claimed but never started to the queue", async () => {
    await seedSubscriber("sub_a", "confirmed")
    await openIncident(T0)
    const job = await jobAt("delivery", T0 + MINUTE, env)
    const { fanOutEvents } = await import("./fanout")
    await fanOutEvents(job)
    await baseEnv.DB.prepare(
      "UPDATE outbox SET state = 'leased', lease_owner = 'dead-runner', lease_fence = 1"
    ).run()
    await baseEnv.DB.prepare(
      "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'delivery'"
    ).run()
    await deliverAt(T0 + 2 * MINUTE, env)
    expect(email.sent).toHaveLength(1)
    expect((await outboxStates())[0]).toMatchObject({ state: "provider_accepted" })
  })
})
