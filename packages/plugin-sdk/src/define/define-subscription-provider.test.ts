import { defineSubscriptionProvider } from "./define-subscription-provider"

it("keeps a JSON-only subscription provider definition unchanged", () => {
  const definition = {
    id: "example",
    name: "Example",
    baseUrl: "https://example.com/v1",
    protocol: "openai" as const,
    models: ["model-1"],
  }
  expect(defineSubscriptionProvider(definition)).toBe(definition)
  expect(JSON.parse(JSON.stringify(defineSubscriptionProvider(definition)))).toEqual(definition)
})

it("preserves billing identity and host-owned usage declarations", () => {
  const definition = defineSubscriptionProvider({
    id: "coding",
    name: "Coding Plan",
    baseUrl: "https://api.example.com/coding/v1",
    protocol: "openai",
    models: ["model-1"],
    billingMode: "subscription",
    brandId: "example",
    relatedProviderIds: ["example-api"],
    usage: {
      request: { path: "/usage", headers: { Authorization: "Bearer {{token}}" } },
      extract: {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            usedPath: "used",
            totalPath: "total",
          },
        ],
      },
    },
  })
  expect(JSON.parse(JSON.stringify(definition))).toEqual(definition)
  expect(definition.billingMode).toBe("subscription")
  expect(definition.usage?.request.headers?.Authorization).toBe("Bearer {{token}}")
})
