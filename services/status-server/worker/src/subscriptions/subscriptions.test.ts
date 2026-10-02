import { beforeEach, describe, expect, it } from "vitest"

import { parseConfirmResult, parseManageResult } from "../../../../../lib/status/validate"
import { bytesToBase64Url } from "../../../../../lib/status/signing"
import {
  T0,
  MINUTE,
  baseEnv,
  context,
  count,
  emailEnv,
  fakeEmail,
  readJson,
  resetOwnerE,
} from "../admin/test-support"
import type { Env } from "../env"
import { emailCapability, handleSubscriptionRoutes } from "./index"

const ORIGIN = "https://status.test"
const ADDRESS = "Alice.Smith+status@Example.COM"

function post(
  env: Env,
  path: string,
  body: unknown,
  opts: { nowMs?: number; origin?: string | null; ip?: string; method?: string } = {}
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    "cf-connecting-ip": opts.ip ?? "203.0.113.7",
  })
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN)
  const method = opts.method ?? "POST"
  const request = new Request(`${ORIGIN}/api/status/v1${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
  })
  return handleSubscriptionRoutes(request, env, context(request, opts.nowMs ?? T0)).then(
    (response) => {
      if (!response) throw new Error("route not handled")
      return response
    }
  )
}

const signup = (email = ADDRESS, extra: Record<string, unknown> = {}) => ({
  email,
  locale: "en",
  componentIds: ["relayData"],
  consentVersion: 1,
  ...extra,
})

async function outboxBodies(purpose: string): Promise<string[]> {
  const rows = await baseEnv.DB.prepare(
    "SELECT text_body FROM outbox WHERE purpose = ? ORDER BY created_at, id"
  )
    .bind(purpose)
    .all<{ text_body: string }>()
  return rows.results.map((row) => row.text_body)
}

function tokenFrom(text: string, action: "confirm" | "manage" | "unsubscribe"): string {
  const match = new RegExp(`#action=${action}&token=([A-Za-z0-9_-]+)`).exec(text)
  if (!match?.[1]) throw new Error(`no ${action} link in mail`)
  return match[1]
}

describe("subscription routes", () => {
  let env: Env

  beforeEach(async () => {
    await resetOwnerE()
    env = emailEnv(fakeEmail())
  })

  it("is unavailable, with no rows written, when any mail prerequisite is missing", async () => {
    expect(emailCapability(baseEnv)).toBe(false)
    expect(emailCapability(env)).toBe(true)
    const variants: Env[] = [
      baseEnv,
      { ...env, FEATURE_EMAIL: "off" },
      { ...env, MAIL_FROM: "" },
      { ...env, SUBSCRIBER_ENC_KEYS: "" },
      { ...env, SUBSCRIBER_HMAC_KEY_ID: "missing" },
      { ...env, IP_BUCKET_SECRET: undefined },
    ]
    for (const variant of variants) {
      const response = await post(variant, "/subscriptions", signup())
      expect(response.status).toBe(503)
      expect(await readJson(response)).toMatchObject({ code: "unavailable" })
    }
    expect(await count("subscribers")).toBe(0)
    expect(await count("outbox")).toBe(0)
  })

  it("never mutates on GET (link scanners) and refuses missing or foreign Origins", async () => {
    for (const path of [
      "/subscriptions",
      "/subscriptions/confirm",
      "/subscriptions/manage",
      "/subscriptions/unsubscribe",
    ]) {
      expect((await post(env, path, {}, { method: "GET" })).status).toBe(405)
    }
    expect((await post(env, "/subscriptions", signup(), { origin: null })).status).toBe(403)
    expect(
      (await post(env, "/subscriptions", signup(), { origin: "https://evil.example" })).status
    ).toBe(403)
    expect(await count("subscribers")).toBe(0)
  })

  it("stores no plaintext address and queues exactly one confirmation", async () => {
    const response = await post(env, "/subscriptions", signup())
    expect(response.status).toBe(202)
    expect(await readJson(response)).toEqual({ status: "accepted" })
    const row = await baseEnv.DB.prepare("SELECT * FROM subscribers").first<
      Record<string, unknown>
    >()
    expect(row).toMatchObject({
      state: "pending",
      locale: "en",
      email_hmac_key_id: "h1",
      email_key_id: "e1",
    })
    for (const value of Object.values(row!)) {
      expect(String(value).toLowerCase()).not.toContain("example.com")
    }
    const [mail] = await outboxBodies("confirmation")
    expect(mail).toContain("https://status.test/status/#action=confirm&token=")
    expect(await count("subscriber_tokens", "purpose = 'confirm'")).toBe(1)
    const tokens = await baseEnv.DB.prepare("SELECT token_hash FROM subscriber_tokens").all<{
      token_hash: string
    }>()
    expect(tokens.results[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(mail).not.toContain(tokens.results[0]!.token_hash)
  })

  it("answers identically whatever the address's state (no enumeration)", async () => {
    const bodies: string[] = []
    const statuses: number[] = []
    const capture = async (response: Response) => {
      statuses.push(response.status)
      bodies.push(await response.text())
    }
    await capture(
      await post(env, "/subscriptions", signup("new@example.com"), { ip: "198.51.100.1" })
    )
    await capture(
      await post(env, "/subscriptions", signup("new@example.com"), { ip: "198.51.100.2" })
    )
    await baseEnv.DB.prepare("UPDATE subscribers SET state = 'suppressed'").run()
    await capture(
      await post(env, "/subscriptions", signup("new@example.com"), { ip: "198.51.100.3" })
    )
    expect(new Set(statuses)).toEqual(new Set([202]))
    expect(new Set(bodies).size).toBe(1)
    expect(await count("outbox")).toBe(1)
  })

  it("applies the per-address cooldown, the global budget and the IP limit", async () => {
    await post(env, "/subscriptions", signup(), { ip: "198.51.100.10" })
    await post(env, "/subscriptions", signup(), { ip: "198.51.100.11", nowMs: T0 + 5 * MINUTE })
    expect(await count("outbox", "purpose = 'confirmation'")).toBe(1)
    await post(env, "/subscriptions", signup(), { ip: "198.51.100.12", nowMs: T0 + 11 * MINUTE })
    expect(await count("outbox", "purpose = 'confirmation'")).toBe(2)

    const budgetEnv = { ...env, SUBSCRIBE_GLOBAL_CONFIRMATIONS_PER_HOUR: "1" }
    await resetOwnerE()
    await post(budgetEnv, "/subscriptions", signup("one@example.com"), { ip: "198.51.100.20" })
    const second = await post(budgetEnv, "/subscriptions", signup("two@example.com"), {
      ip: "198.51.100.21",
    })
    expect(second.status).toBe(202)
    expect(await count("outbox")).toBe(1)

    await resetOwnerE()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (await post(env, "/subscriptions", signup(`u${attempt}@example.com`), { ip: "192.0.2.9" }))
          .status
      )
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429])
    // No raw IP is stored.
    const buckets = await baseEnv.DB.prepare("SELECT bucket FROM rate_buckets").all<{
      bucket: string
    }>()
    expect(buckets.results.some((row) => row.bucket.includes("192.0.2.9"))).toBe(false)
  })

  it("confirms once, idempotently, with purpose-scoped tokens", async () => {
    await post(env, "/subscriptions", signup())
    const confirmToken = tokenFrom((await outboxBodies("confirmation"))[0]!, "confirm")

    expect((await post(env, "/subscriptions/confirm", { token: "short" })).status).toBe(400)
    const unknown = await post(env, "/subscriptions/confirm", { token: "A".repeat(43) })
    expect(await readJson(unknown)).toMatchObject({ code: "token_invalid" })

    const first = await post(
      env,
      "/subscriptions/confirm",
      { token: confirmToken },
      { nowMs: T0 + MINUTE }
    )
    expect(first.status).toBe(200)
    const firstBody = await readJson(first)
    const parsed = parseConfirmResult(firstBody)
    expect(parsed.ok).toBe(true)
    expect(firstBody).toMatchObject({
      preferences: { maskedEmail: "A•••@example.com", revision: 1, componentIds: ["relayData"] },
    })

    const again = await post(
      env,
      "/subscriptions/confirm",
      { token: confirmToken },
      { nowMs: T0 + 2 * MINUTE }
    )
    expect(again.status).toBe(200)
    expect(await readJson(again)).toEqual(firstBody)
    expect(await count("subscribers", "state = 'confirmed' AND preference_revision = 1")).toBe(1)
    expect(await count("outbox", "purpose = 'welcome'")).toBe(1)

    const manageToken = tokenFrom((await outboxBodies("welcome"))[0]!, "manage")
    expect(
      await readJson(await post(env, "/subscriptions/confirm", { token: manageToken }))
    ).toMatchObject({ code: "token_invalid" })
  })

  it("rejects an expired confirmation", async () => {
    await post(env, "/subscriptions", signup())
    const token = tokenFrom((await outboxBodies("confirmation"))[0]!, "confirm")
    const response = await post(
      env,
      "/subscriptions/confirm",
      { token },
      { nowMs: T0 + 25 * 60 * MINUTE }
    )
    expect(response.status).toBe(410)
    expect(await readJson(response)).toMatchObject({ code: "token_expired" })
    expect(await count("subscribers", "state = 'pending'")).toBe(1)
  })

  it("keeps a confirmed subscriber's preferences on repeat signup and mails a manage link", async () => {
    await post(env, "/subscriptions", signup())
    await post(env, "/subscriptions/confirm", {
      token: tokenFrom((await outboxBodies("confirmation"))[0]!, "confirm"),
    })
    await post(env, "/subscriptions", signup(ADDRESS, { locale: "zh-CN", componentIds: [] }), {
      nowMs: T0 + 11 * MINUTE,
      ip: "198.51.100.40",
    })
    expect(
      await count(
        "subscribers",
        "state = 'confirmed' AND locale = 'en' AND component_ids_json = '[\"relayData\"]'"
      )
    ).toBe(1)
    expect(await count("outbox", "purpose = 'manage_link'")).toBe(1)
  })

  it("manages preferences with revision checks", async () => {
    await post(env, "/subscriptions", signup())
    await post(env, "/subscriptions/confirm", {
      token: tokenFrom((await outboxBodies("confirmation"))[0]!, "confirm"),
    })
    const token = tokenFrom((await outboxBodies("welcome"))[0]!, "manage")

    const read = await post(env, "/subscriptions/manage", { token, operation: "read" })
    expect(parseManageResult(await readJson(read)).ok).toBe(true)
    const stale = await post(env, "/subscriptions/manage", {
      token,
      operation: "update",
      expectedRevision: 0,
      locale: "zh-CN",
      componentIds: [],
    })
    expect(stale.status).toBe(409)
    expect(await readJson(stale)).toMatchObject({ code: "revision_conflict", currentRevision: 1 })
    const updated = await post(env, "/subscriptions/manage", {
      token,
      operation: "update",
      expectedRevision: 1,
      locale: "zh-CN",
      componentIds: [],
    })
    expect(await readJson(updated)).toMatchObject({
      status: "ok",
      preferences: { locale: "zh-CN", componentIds: [], revision: 2 },
    })
    expect((await post(env, "/subscriptions/manage", { token, operation: "delete" })).status).toBe(
      400
    )
  })

  it("unsubscribes idempotently, cancels unsent mail and revokes manage links", async () => {
    await post(env, "/subscriptions", signup())
    await post(env, "/subscriptions/confirm", {
      token: tokenFrom((await outboxBodies("confirmation"))[0]!, "confirm"),
    })
    const token = tokenFrom((await outboxBodies("welcome"))[0]!, "unsubscribe")
    expect(await count("outbox", "state = 'pending'")).toBe(2)

    const first = await post(
      env,
      "/subscriptions/unsubscribe",
      { token },
      { nowMs: T0 + 5 * MINUTE }
    )
    expect(await readJson(first)).toEqual({ status: "unsubscribed" })
    expect(await count("outbox", "state = 'cancelled'")).toBe(2)
    const row = await baseEnv.DB.prepare(
      "SELECT state, consent_version, purge_after FROM subscribers"
    ).first<Record<string, number | string>>()
    expect(row).toMatchObject({
      state: "unsubscribed",
      consent_version: 2,
      purge_after: T0 + 5 * MINUTE + 30 * 24 * 60 * MINUTE,
    })

    const again = await post(
      env,
      "/subscriptions/unsubscribe",
      { token },
      { nowMs: T0 + 6 * MINUTE }
    )
    expect(await readJson(again)).toEqual({ status: "unsubscribed" })
    const manage = await post(env, "/subscriptions/manage", { token, operation: "read" })
    expect(await readJson(manage)).toMatchObject({ code: "token_invalid" })

    // A later signup is a fresh double opt-in, and the old link cannot end it.
    await post(env, "/subscriptions", signup(), { nowMs: T0 + 20 * MINUTE, ip: "198.51.100.50" })
    expect(await count("subscribers", "state = 'pending' AND consent_version = 2")).toBe(1)
    expect(
      await readJson(
        await post(env, "/subscriptions/unsubscribe", { token }, { nowMs: T0 + 21 * MINUTE })
      )
    ).toMatchObject({
      code: "token_invalid",
    })
  })

  it("finds rows under an older HMAC key after rotation and re-keys them", async () => {
    await post(env, "/subscriptions", signup())
    const random = () => {
      const bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      return bytesToBase64Url(bytes)
    }
    const rotated: Env = {
      ...env,
      SUBSCRIBER_HMAC_KEYS: JSON.stringify({
        ...JSON.parse(baseEnv.SUBSCRIBER_HMAC_KEYS!),
        h2: random(),
      }),
      SUBSCRIBER_HMAC_KEY_ID: "h2",
      SUBSCRIBER_ENC_KEYS: JSON.stringify({
        ...JSON.parse(baseEnv.SUBSCRIBER_ENC_KEYS!),
        e2: random(),
      }),
      SUBSCRIBER_ENC_KEY_ID: "e2",
    }
    // Different casing of the domain normalises to the same address.
    await post(
      rotated,
      "/subscriptions",
      signup("Alice.Smith+status@example.com", { locale: "zh-CN" }),
      {
        nowMs: T0 + 11 * MINUTE,
        ip: "198.51.100.60",
      }
    )
    expect(await count("subscribers")).toBe(1)
    expect(await count("subscribers", "email_hmac_key_id = 'h2' AND email_key_id = 'e2'")).toBe(1)
    const tokens = await outboxBodies("confirmation")
    expect(tokens).toHaveLength(2)
    const confirmed = await post(
      rotated,
      "/subscriptions/confirm",
      { token: tokenFrom(tokens[1]!, "confirm") },
      { nowMs: T0 + 12 * MINUTE }
    )
    expect(await readJson(confirmed)).toMatchObject({
      preferences: { maskedEmail: "A•••@example.com", locale: "zh-CN" },
    })
  })

  it("refuses malformed addresses and stale consent versions", async () => {
    expect((await post(env, "/subscriptions", signup("not-an-address"))).status).toBe(400)
    expect((await post(env, "/subscriptions", signup("a@b"), { ip: "198.51.100.70" })).status).toBe(
      400
    )
    expect(
      (
        await post(env, "/subscriptions", signup(ADDRESS, { consentVersion: 2 }), {
          ip: "198.51.100.71",
        })
      ).status
    ).toBe(400)
    expect(await count("subscribers")).toBe(0)
  })
})
