import {
  validateSubscriptionProvider,
  type PluginSubscriptionProviderDefinition,
  type SubscriptionUsageDefinition,
} from "./provider-definition"

const legacy: PluginSubscriptionProviderDefinition = {
  id: "example",
  name: "Example",
  baseUrl: "http://localhost:8000/v1",
  protocol: "openai",
  models: ["model-1"],
}

const usage: SubscriptionUsageDefinition = {
  request: { path: "/coding/v1/usages", useBaseUrlOrigin: true },
  extract: {
    kind: "window",
    windows: [
      {
        id: "session",
        labelKey: "subscription.limits.meter.session",
        remainingPath: "usage.remaining",
        totalPath: "usage.limit",
        resetAtPath: "usage.resetTime",
        resetUnit: "unix",
      },
    ],
  },
}

function definition(overrides: Record<string, unknown> = {}): PluginSubscriptionProviderDefinition {
  return {
    ...legacy,
    baseUrl: "https://api.kimi.com/coding/v1",
    billingMode: "subscription",
    brandId: "kimi",
    relatedProviderIds: ["moonshot", "kimi-coding"],
    usage: structuredClone(usage),
    ...overrides,
  } as PluginSubscriptionProviderDefinition
}

describe("subscription manifest contract", () => {
  it("preserves legacy declarations and accepts explicit pay-as-you-go services", () => {
    expect(() => validateSubscriptionProvider(legacy)).not.toThrow()
    expect(() =>
      validateSubscriptionProvider({ ...legacy, billingMode: "pay-as-you-go" })
    ).not.toThrow()
  })

  it.each([
    ["kimi", usage],
    [
      "zhipu",
      {
        baseUrl: "https://open.bigmodel.cn",
        request: {
          path: "/api/monitor/usage/quota/limit",
          headers: { Authorization: "{{token}}" },
        },
        extract: {
          kind: "window",
          windows: [
            {
              id: "session",
              labelKey: "subscription.limits.meter.session",
              usedPctPath: "percentage",
              select: { arrayPath: "data.limits", by: "type", equals: "TOKENS_LIMIT" },
            },
          ],
        },
      },
    ],
    [
      "minimax",
      {
        baseUrl: "https://api.minimaxi.com",
        request: {
          path: "/v1/token_plan/remains",
          method: "GET",
          headers: { Authorization: "Bearer {{token}}" },
        },
        extract: {
          kind: "window",
          windows: [
            {
              id: "session",
              labelKey: "subscription.limits.meter.session",
              usedPctPath: "current_interval_remaining_percent",
              invert: true,
              select: { arrayPath: "model_remains", by: "model_name", equals: "general" },
            },
          ],
        },
      },
    ],
  ])("accepts %s declarative usage without executing plugin code", (_vendor, declaration) => {
    expect(() => validateSubscriptionProvider(definition({ usage: declaration }))).not.toThrow()
  })

  it.each([
    { billingMode: "metered" },
    { billingMode: false },
    { brandId: "../../kimi" },
    { brandId: "Kimi" },
    { brandId: {} },
    { relatedProviderIds: ["moonshot", "moonshot"] },
    { relatedProviderIds: [42] },
    { relatedProviderIds: "moonshot" },
    { relatedProviderIds: Array.from({ length: 33 }, (_, index) => `provider-${index}`) },
    { baseUrl: "http://api.kimi.com/coding/v1" },
  ])("rejects invalid billing and provider identity: %j", (overrides) => {
    expect(() => validateSubscriptionProvider(definition(overrides))).toThrow()
  })

  it.each([
    "https://evil.example/?token={{token}}",
    "//evil.example",
    "/../secret",
    "/api/./usage",
    "/%2e%2e/secret",
    "/%2f%2fevil.example",
    "/api\\usage",
    "/api\r\nHost: evil.example",
    "/usage?token={{token}}",
    "/{{token}}",
    "/usage#fragment",
    "relative/path",
  ])("rejects exfiltration or unsafe usage path %j", (path) => {
    const value = structuredClone(usage)
    value.request.path = path
    expect(() => validateSubscriptionProvider(definition({ usage: value }))).toThrow()
  })

  it.each([
    { Host: "evil.example" },
    { Cookie: "session=x" },
    { "X-Cognia-Host-Token": "{{token}}" },
    { "Proxy-Authorization": "{{token}}" },
    { Authorization: "Bearer {{token}}\r\nHost: evil.example" },
    { Authorization: "Bearer {{accountId}}" },
    { Authorization: "Bearer {{baseUrl}}" },
    { Authorization: "Bearer {{ token }}" },
    { "Invalid:header": "value" },
    { Authorization: "{{token}}", authorization: "other" },
    { Accept: 1 },
  ])("rejects unsafe headers %j", (headers) => {
    const value = {
      ...structuredClone(usage),
      request: { ...usage.request, headers },
    }
    expect(() => validateSubscriptionProvider(definition({ usage: value }))).toThrow()
  })

  it.each([
    { baseUrl: "http://usage.example" },
    { baseUrl: "https://user:pass@usage.example" },
    { baseUrl: "https://usage.example/?token=secret" },
    { baseUrl: "https://usage.example/#secret" },
    { baseUrl: "https://{{token}}.example" },
    { baseUrl: 42 },
    { request: { path: "/usage", method: "POST" } },
    { request: { path: "/usage", useBaseUrlOrigin: "true" } },
    { request: { path: "/usage", callback: () => 1 } },
    { request: { path: "/usage", headers: { Accept: undefined } } },
    { callback: () => 1 },
    { extract: { kind: "window", windows: [] } },
    {
      extract: {
        kind: "window",
        windows: Array.from({ length: 17 }, () =>
          usage.extract.kind === "window" ? usage.extract.windows[0] : {}
        ),
      },
    },
    {
      extract: {
        kind: "window",
        windows: [{ id: "session", labelKey: "usage", totalPath: "total" }],
      },
    },
    { extract: { kind: "balance" } },
    { extract: { kind: "balance", remainingPath: "__proto__.token" } },
    { extract: { kind: "balance", remainingPath: "data.constructor.secret" } },
    { extract: { kind: "balance", remainingPath: "data.balance", scale: Infinity } },
    { extract: { kind: "balance", remainingPath: "data.balance", scale: -1 } },
    { extract: { kind: "balance", remainingPath: "data.balance", currency: "USD\n" } },
  ])("rejects malformed JSON usage declarations %j", (overrides) => {
    expect(() =>
      validateSubscriptionProvider(definition({ usage: { ...usage, ...overrides } }))
    ).toThrow()
  })

  it.each([
    { usedPctScale: 0 },
    { usedPctScale: NaN },
    { usedPctScale: 1e13 },
    { invert: "yes" },
    { resetUnit: "hours" },
    { resetAtPath: undefined, resetUnit: "iso" },
    { select: { arrayPath: "data", by: "type", equals: true } },
    { select: { arrayPath: "data", by: "prototype", equals: "session" } },
    { select: { arrayPath: "data", by: "type", equals: "session", callback: "eval" } },
  ])("rejects invalid usage window fields %j", (overrides) => {
    const value = structuredClone(usage)
    if (value.extract.kind !== "window") throw new Error("Expected window fixture")
    Object.assign(value.extract.windows[0], overrides)
    expect(() => validateSubscriptionProvider(definition({ usage: value }))).toThrow()
  })

  it("rejects unsafe object keys, accessors, and cycles", () => {
    const poisoned = JSON.parse(
      '{"request":{"path":"/usage"},"extract":{"kind":"balance","remainingPath":"balance"},"__proto__":{}}'
    )
    expect(() => validateSubscriptionProvider(definition({ usage: poisoned }))).toThrow()
    const getter = {
      ...usage,
      get baseUrl() {
        throw new Error("Getter executed")
      },
    }
    expect(() => validateSubscriptionProvider(definition({ usage: getter }))).toThrow("only JSON")
    const cyclic: Record<string, unknown> = { ...usage }
    cyclic.self = cyclic
    expect(() => validateSubscriptionProvider(definition({ usage: cyclic }))).toThrow()
  })

  it("accepts balance extraction and count-based usage with a meaningful denominator", () => {
    expect(() =>
      validateSubscriptionProvider(
        definition({
          usage: {
            request: { path: "/balance" },
            extract: {
              kind: "balance",
              remainingPath: "data.remaining",
              scale: 0.01,
              currency: "CNY",
            },
          },
        })
      )
    ).not.toThrow()
    const value = structuredClone(usage)
    if (value.extract.kind !== "window") throw new Error("Expected window fixture")
    delete value.extract.windows[0].remainingPath
    value.extract.windows[0].usedPath = "usage.used"
    expect(() => validateSubscriptionProvider(definition({ usage: value }))).not.toThrow()
  })
})
