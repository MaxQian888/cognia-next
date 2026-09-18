/**
 * Tests for lib/notifications/delivery/feishu-webhook.ts — the one-way
 * Feishu webhook executor. Covers the secret-ref split, the HMAC sign, the
 * request-body shape (text vs interactive card), and — most importantly —
 * the attempt-outcome classification across the full platform-response
 * matrix, all via injected deps (no network, no Tauri).
 */

import {
  splitSecretRef,
  feishuSign,
  buildFeishuWebhookBody,
  deliverFeishuWebhook,
  type FeishuWebhookDeps,
} from "./feishu-webhook"
import type { NotificationTarget } from "@/types/notifications/target"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { TauriHttpResponse } from "@/types/connectors/adapter"

const payload: NotificationRenderedPayload = {
  title: "Deploy failed",
  body: "boom",
  level: "error",
  disclosureLevel: "internal",
  clippedFactCount: 0,
  contentHash: "h",
}

function target(over: { signing?: string; malformed?: boolean } = {}): NotificationTarget {
  return {
    id: "t1",
    version: 1,
    scope: { namespaceId: "n", accountId: "a", authorityHostId: "h" },
    scopeKey: "sk",
    label: "wh",
    address: {
      kind: "feishu-webhook",
      endpointSecretRef: over.malformed ? "nocolon" : "svc:acct",
      ...(over.signing ? { signingSecretRef: over.signing } : {}),
      region: "feishu",
    },
    addressFingerprint: "fp",
    enabled: true,
    enabledKey: 1,
    consent: { mode: "proactive", grantRef: "g", grantedBy: "a", grantedAt: 0 },
    disclosureProfileId: "internal",
    locale: "en",
    timezone: "UTC",
    createdAt: 0,
    updatedAt: 0,
  }
}

function deps(over: Partial<FeishuWebhookDeps> = {}): FeishuWebhookDeps {
  return {
    sendHttp:
      over.sendHttp ?? (async () => ({ status: 200, body: '{"code":0}' }) as TauriHttpResponse),
    resolveSecret:
      over.resolveSecret ?? (async (ref) => (ref === "svc:acct" ? "https://hook/secret" : null)),
    now: over.now ?? (() => 1_700_000_000_000),
    ...(over.hmacSha256Base64 ? { hmacSha256Base64: over.hmacSha256Base64 } : {}),
  }
}

function http(status: number, body: unknown): TauriHttpResponse {
  return {
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
  } as TauriHttpResponse
}

describe("splitSecretRef", () => {
  it("splits a `{service}:{account}` ref", () => {
    expect(splitSecretRef("svc:acct")).toEqual({ service: "svc", account: "acct" })
  })

  it("keeps a colon inside the account half", () => {
    expect(splitSecretRef("svc:a:b")).toEqual({ service: "svc", account: "a:b" })
  })

  it("returns null for a malformed ref", () => {
    expect(splitSecretRef("nocolon")).toBeNull()
    expect(splitSecretRef(":acct")).toBeNull()
    expect(splitSecretRef("svc:")).toBeNull()
  })
})

describe("feishuSign", () => {
  it("signs the empty message with the `{ts}\\n{secret}` key", async () => {
    const seen: { key?: string; message?: string } = {}
    const sign = await feishuSign("1700000000", "sekret", async (k, m) => {
      seen.key = k
      seen.message = m
      return "SIGNATURE"
    })
    expect(seen.key).toBe("1700000000\nsekret")
    expect(seen.message).toBe("")
    expect(sign).toBe("SIGNATURE")
  })
})

describe("buildFeishuWebhookBody", () => {
  it("builds a plain-text body when there are no actions", () => {
    const body = buildFeishuWebhookBody({ payload })
    expect(body.msg_type).toBe("text")
    expect((body.content as { text: string }).text).toContain("Deploy failed")
    expect((body.content as { text: string }).text).toContain("boom")
  })

  it("builds an interactive card when actions are present", () => {
    const withActions: NotificationRenderedPayload = {
      ...payload,
      actions: [{ kind: "link", label: "Open run", ref: "https://x" }],
    }
    const body = buildFeishuWebhookBody({ payload: withActions })
    expect(body.msg_type).toBe("interactive")
    const card = body.card as { header: { template: string } }
    expect(card.header.template).toBe("red") // error level → red
  })

  it("stamps timestamp + sign when provided", () => {
    const body = buildFeishuWebhookBody({ payload, timestampSec: "100", sign: "SIG" })
    expect(body.timestamp).toBe("100")
    expect(body.sign).toBe("SIG")
  })
})

describe("deliverFeishuWebhook", () => {
  it("accepts on a code:0 envelope + surfaces the message id", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({ sendHttp: async () => http(200, { code: 0, data: { message_id: "om_1" } }) }),
    })
    expect(result.outcome).toBe("accepted")
    expect(result.platformMessageId).toBe("om_1")
  })

  it("returns invalid-target for a non-webhook address", async () => {
    const t = target()
    t.address = { kind: "connector", adapterId: "a", deliveryTarget: {} as never }
    const result = await deliverFeishuWebhook({ target: t, payload, deps: deps() })
    expect(result.outcome).toBe("invalid-target")
    expect(result.errorCode).toBe("not-a-webhook-target")
  })

  it("returns invalid-target for a malformed endpoint ref", async () => {
    const result = await deliverFeishuWebhook({
      target: target({ malformed: true }),
      payload,
      deps: deps(),
    })
    expect(result.outcome).toBe("invalid-target")
    expect(result.errorCode).toBe("endpoint-ref-malformed")
  })

  it("returns invalid-target when the endpoint secret does not resolve", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({ resolveSecret: async () => null }),
    })
    expect(result.outcome).toBe("invalid-target")
    expect(result.errorCode).toBe("endpoint-secret-missing")
  })

  it("sends unsigned when the signing secret does not resolve", async () => {
    const seenBodies: string[] = []
    const result = await deliverFeishuWebhook({
      target: target({ signing: "svc:sign" }),
      payload,
      deps: deps({
        resolveSecret: async (ref) => (ref === "svc:acct" ? "https://hook" : null),
        sendHttp: async (req) => {
          seenBodies.push(String(req.body))
          return http(200, { code: 0 })
        },
      }),
    })
    expect(result.outcome).toBe("accepted")
    expect(JSON.parse(seenBodies[0]).sign).toBeUndefined()
  })

  it("signs when the signing secret resolves", async () => {
    const seenBodies: string[] = []
    await deliverFeishuWebhook({
      target: target({ signing: "svc:sign" }),
      payload,
      deps: deps({
        resolveSecret: async (ref) =>
          ref === "svc:acct" ? "https://hook" : ref === "svc:sign" ? "SIGNSECRET" : null,
        hmacSha256Base64: async () => "SIGVAL",
        sendHttp: async (req) => {
          seenBodies.push(String(req.body))
          return http(200, { code: 0 })
        },
      }),
    })
    expect(JSON.parse(seenBodies[0]).sign).toBe("SIGVAL")
    expect(JSON.parse(seenBodies[0]).timestamp).toBe("1700000000")
  })

  it("classifies a transport fault as timeout-unknown (never blindly re-sent)", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({
        sendHttp: async () => {
          throw new Error("ECONNRESET")
        },
      }),
    })
    expect(result.outcome).toBe("timeout-unknown")
  })

  it("classifies HTTP 429 as rate-limited", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({ sendHttp: async () => http(429, {}) }),
    })
    expect(result.outcome).toBe("rate-limited")
  })

  it("classifies 401/403 as auth-failed", async () => {
    expect(
      (
        await deliverFeishuWebhook({
          target: target(),
          payload,
          deps: deps({ sendHttp: async () => http(401, {}) }),
        })
      ).outcome
    ).toBe("auth-failed")
    expect(
      (
        await deliverFeishuWebhook({
          target: target(),
          payload,
          deps: deps({ sendHttp: async () => http(403, {}) }),
        })
      ).outcome
    ).toBe("auth-failed")
  })

  it("classifies 404/410 as invalid-target", async () => {
    expect(
      (
        await deliverFeishuWebhook({
          target: target(),
          payload,
          deps: deps({ sendHttp: async () => http(404, {}) }),
        })
      ).outcome
    ).toBe("invalid-target")
    expect(
      (
        await deliverFeishuWebhook({
          target: target(),
          payload,
          deps: deps({ sendHttp: async () => http(410, {}) }),
        })
      ).outcome
    ).toBe("invalid-target")
  })

  it("classifies a 5xx as network-error (retryable)", async () => {
    expect(
      (
        await deliverFeishuWebhook({
          target: target(),
          payload,
          deps: deps({ sendHttp: async () => http(500, {}) }),
        })
      ).outcome
    ).toBe("network-error")
  })

  it("classifies a non-2xx non-special status as rejected", async () => {
    expect(
      (
        await deliverFeishuWebhook({
          target: target(),
          payload,
          deps: deps({ sendHttp: async () => http(400, {}) }),
        })
      ).outcome
    ).toBe("rejected")
  })

  it("treats a 2xx with an unparseable body as accepted-but-unverified", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({ sendHttp: async () => http(200, "not json") }),
    })
    expect(result.outcome).toBe("accepted")
  })

  it("classifies a Feishu rate code (11232) as rate-limited", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({ sendHttp: async () => http(200, { code: 11232, msg: "rate" }) }),
    })
    expect(result.outcome).toBe("rate-limited")
  })

  it("classifies a Feishu sign code (19021) as auth-failed", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({ sendHttp: async () => http(200, { code: 19021, msg: "sign match fail" }) }),
    })
    expect(result.outcome).toBe("auth-failed")
  })

  it("classifies an unknown nonzero code as rejected", async () => {
    const result = await deliverFeishuWebhook({
      target: target(),
      payload,
      deps: deps({ sendHttp: async () => http(200, { code: 99999, msg: "weird" }) }),
    })
    expect(result.outcome).toBe("rejected")
  })
})
