import { resolveSubscriptionEndpoint, subscriptionRequestHeaders } from "./provider-policy"
import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"

const definition: SubscriptionProviderDefinition = {
  id: "test:kimi",
  name: "Kimi Code",
  source: "plugin",
  authMode: "api-key",
  protocol: "anthropic",
  baseUrl: "https://api.kimi.com/coding/",
  billingMode: "subscription",
}

it.each([undefined, "https://api.kimi.com/coding/", "https://api.kimi.com/coding/v1/"])(
  "accepts the declared subscription endpoint and its protocol-normalized equivalent %s",
  (url) => {
    expect(resolveSubscriptionEndpoint(definition, url)).toBe("https://api.kimi.com/coding/v1")
  }
)

it.each([
  "https://api.moonshot.cn/v1",
  "https://api.kimi.com/v1",
  "http://api.kimi.com/coding/",
  "https://api.kimi.com/coding/?key=secret",
  "https://user:secret@api.kimi.com/coding/",
])("rejects changing a subscription account to another billing endpoint %s", (url) => {
  expect(() => resolveSubscriptionEndpoint(definition, url)).toThrow()
})

it("preserves endpoint customization for legacy unmanaged providers", () => {
  expect(
    resolveSubscriptionEndpoint(
      { ...definition, billingMode: undefined },
      "https://relay.example/proxy"
    )
  ).toBe("https://relay.example/proxy/v1")
})

it.each(["Authorization", "X-Api-Key", "api-key", "Cookie", "Host"])(
  "rejects a preset that replaces subscription authentication through %s",
  (header) => {
    expect(() => subscriptionRequestHeaders(definition, { [header]: "payg-key" })).toThrow()
  }
)

it("preserves harmless headers without exposing host-internal configuration", () => {
  expect(
    subscriptionRequestHeaders(definition, { "X-Tenant": "team", "x-cognia-private": "hidden" })
  ).toEqual({ "X-Tenant": "team" })
})
