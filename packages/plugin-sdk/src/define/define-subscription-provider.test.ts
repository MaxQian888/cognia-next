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
