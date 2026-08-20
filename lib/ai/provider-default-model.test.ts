import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"

import { ANTHROPIC_DEFAULT_MODEL } from "./provider-default-model"

describe("ANTHROPIC_DEFAULT_MODEL", () => {
  it("is the catalog's declared default, not a literal", () => {
    const anthropic = getBuiltInProviderCatalog().find((p) => p.id === "anthropic")
    expect(ANTHROPIC_DEFAULT_MODEL).toBe(anthropic?.defaultModel)
  })

  it("names a model the catalog actually carries", () => {
    // A default that is not in its own `models` list resolves no metadata:
    // no context length, no capability flags, no pricing.
    const anthropic = getBuiltInProviderCatalog().find((p) => p.id === "anthropic")
    expect(anthropic?.models.map((m) => m.id)).toContain(ANTHROPIC_DEFAULT_MODEL)
  })
})
