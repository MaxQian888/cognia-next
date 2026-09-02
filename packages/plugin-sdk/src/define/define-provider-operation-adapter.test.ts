import { defineProviderOperationAdapter } from "./define-provider-operation-adapter"

describe("defineProviderOperationAdapter", () => {
  it("returns the adapter definition unchanged (pure pass-through)", () => {
    const handler = jest.fn(async () => ({ images: [] }))
    const def = defineProviderOperationAdapter({
      id: "acme:images",
      name: "Acme images",
      operationId: "images.generate",
      providerMatch: { kind: "protocol", protocol: "openai" },
      handler,
    })
    expect(def).toMatchObject({ id: "acme:images", operationId: "images.generate" })
    expect(def.handler).toBe(handler)
  })
})
