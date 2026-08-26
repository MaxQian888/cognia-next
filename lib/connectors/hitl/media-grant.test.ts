import { resolveMediaModelPolicy } from "@/lib/connectors/media-model-gate"

import {
  applyMediaGrantCallback,
  buildMediaGrantSurface,
  mediaGrantFor,
  MEDIA_GRANT_ALWAYS_PREFIX,
  MEDIA_GRANT_DENY_PREFIX,
  MEDIA_GRANT_SESSION_MS,
  MEDIA_GRANT_SESSION_PREFIX,
  requestMediaGrant,
} from "./media-grant"

const NOW = 1_700_000_000_000

describe("mediaGrantFor", () => {
  it("scopes the grant to the provider that was asked about", () => {
    expect(mediaGrantFor("allow_always", "anthropic", NOW)).toEqual({
      policy: "allow_cloud_binary",
      providers: ["anthropic"],
      grantedAt: NOW,
    })
  })

  it("gives the 24h choice an expiry and the always choice none", () => {
    expect(mediaGrantFor("allow_24h", "anthropic", NOW)?.expiresAt).toBe(
      NOW + MEDIA_GRANT_SESSION_MS
    )
    expect(mediaGrantFor("allow_always", "anthropic", NOW)).not.toHaveProperty("expiresAt")
  })

  it("grants nothing on a refusal", () => {
    expect(mediaGrantFor("deny", "anthropic", NOW)).toBeNull()
  })

  /**
   * The grant is only worth anything if the resolver honours it, so this asserts
   * against the real resolver rather than the shape: `allow_cloud_binary` had
   * no writer at all before this module, and a grant the resolver ignores would
   * be the same dead end with more steps.
   */
  it("produces a grant the media resolver actually honours", () => {
    const grant = mediaGrantFor("allow_24h", "anthropic", NOW)!
    expect(
      resolveMediaModelPolicy({
        adapter: {},
        override: { mediaModelGrant: grant },
        adapterDefaultProvider: "anthropic",
        now: NOW + 1_000,
      })
    ).toBe("allow_cloud_binary")
  })

  it("expires on its own, with no sweep", () => {
    const grant = mediaGrantFor("allow_24h", "anthropic", NOW)!
    expect(
      resolveMediaModelPolicy({
        adapter: {},
        override: { mediaModelGrant: grant },
        adapterDefaultProvider: "anthropic",
        now: NOW + MEDIA_GRANT_SESSION_MS + 1,
      })
    ).toBe("local_extract_only")
  })

  it("does not carry over to a provider it did not name", () => {
    const grant = mediaGrantFor("allow_always", "anthropic", NOW)!
    expect(
      resolveMediaModelPolicy({
        adapter: {},
        override: { mediaModelGrant: grant, providerOverride: "openai" },
        adapterDefaultProvider: "anthropic",
        now: NOW,
      })
    ).toBe("local_extract_only")
  })
})

describe("buildMediaGrantSurface", () => {
  it("names the provider in the prompt — that IS the decision", () => {
    const surface = buildMediaGrantSurface({ bindingId: "b1", provider: "anthropic" })
    expect((surface.components.prompt as { text: string }).text).toContain("anthropic")
  })

  it("gives each button its own routable action id", () => {
    const surface = buildMediaGrantSurface({ bindingId: "b1", provider: "anthropic" })
    expect((surface.components.session as { value: string }).value).toBe(
      `${MEDIA_GRANT_SESSION_PREFIX}b1`
    )
    expect((surface.components.always as { value: string }).value).toBe(
      `${MEDIA_GRANT_ALWAYS_PREFIX}b1`
    )
    expect((surface.components.deny as { value: string }).value).toBe(
      `${MEDIA_GRANT_DENY_PREFIX}b1`
    )
  })

  // Platforms without native cards get the mirror, including the numeric hint
  // personal WeChat needs.
  it("carries a fallback mirror for card-less platforms", () => {
    const surface = buildMediaGrantSurface({ bindingId: "b1", provider: "anthropic" })
    expect(surface.widget?.fallbackText).toContain("回复 1")
  })
})

describe("requestMediaGrant", () => {
  const base = {
    adapterId: "cai_1",
    conversationKey: "telegram:cai_1:c1",
    conversationRef: {
      platform: "telegram" as const,
      adapterId: "cai_1",
      chatId: "c1",
      messageId: "m1",
    },
    provider: "anthropic",
    now: NOW,
  }

  it("records one binding per button, each with its own decision", async () => {
    const recordBinding = jest.fn(async () => undefined)
    await requestMediaGrant({
      ...base,
      recordBinding: recordBinding as never,
      enqueue: (async () => ({})) as never,
      audit: (async () => undefined) as never,
    })
    expect(recordBinding).toHaveBeenCalledTimes(3)
    const decisions = recordBinding.mock.calls.map(
      (call) => (call[0] as { payload: { decision: string } }).payload.decision
    )
    expect(decisions).toEqual(["allow_24h", "allow_always", "deny"])
  })

  // Consent belongs to the person who sent the attachment, not to whoever is
  // watching the channel.
  it("scopes the buttons to the sender when one is known", async () => {
    const recordBinding = jest.fn(async () => undefined)
    await requestMediaGrant({
      ...base,
      initiatorUserId: "u42",
      recordBinding: recordBinding as never,
      enqueue: (async () => ({})) as never,
      audit: (async () => undefined) as never,
    })
    expect((recordBinding.mock.calls[0][0] as { actorScope: unknown }).actorScope).toEqual({
      mode: "initiator",
      allowedUserIds: ["u42"],
    })
  })

  it("falls back to operators-only with no known sender", async () => {
    const recordBinding = jest.fn(async () => undefined)
    await requestMediaGrant({
      ...base,
      recordBinding: recordBinding as never,
      enqueue: (async () => ({})) as never,
      audit: (async () => undefined) as never,
    })
    expect((recordBinding.mock.calls[0][0] as { actorScope: unknown }).actorScope).toEqual({
      mode: "operators",
    })
  })

  it("delivers the card and audits the ask", async () => {
    const enqueue = jest.fn(async () => ({}))
    const audit = jest.fn(async () => undefined)
    await requestMediaGrant({
      ...base,
      recordBinding: (async () => undefined) as never,
      enqueue: enqueue as never,
      audit: audit as never,
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "media_grant.requested", fields: { provider: "anthropic" } })
    )
  })
})

describe("applyMediaGrantCallback", () => {
  it("writes the grant the press means", async () => {
    const persist = jest.fn(async () => ({}) as never)
    const result = await applyMediaGrantCallback({
      adapterId: "cai_1",
      conversationKey: "telegram:cai_1:c1",
      decision: "allow_always",
      provider: "anthropic",
      now: NOW,
      persist: persist as never,
    })
    expect(result.granted).toBe(true)
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        section: "permissions",
        source: "command.media_grant",
        patch: {
          mediaModelGrant: {
            policy: "allow_cloud_binary",
            providers: ["anthropic"],
            grantedAt: NOW,
          },
        },
      })
    )
  })

  /**
   * "Not now" on a chat that was already granted means withdraw it. Doing
   * nothing would leave the previous grant in force and make the button a lie.
   */
  it("clears an existing grant on a refusal", async () => {
    const persist = jest.fn(async () => ({}) as never)
    const result = await applyMediaGrantCallback({
      adapterId: "cai_1",
      conversationKey: "telegram:cai_1:c1",
      decision: "deny",
      provider: "anthropic",
      now: NOW,
      persist: persist as never,
    })
    expect(result.granted).toBe(false)
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { mediaModelGrant: undefined } })
    )
  })
})
