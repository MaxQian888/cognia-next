import type { Character } from "@cognia/agent-config-types"

import {
  AGENT_OVERRIDE_FIELDS,
  countAgentOverrides,
  emptyAgentOverrides,
  pickAgentOverrides,
} from "./agent-overrides"

describe("agent overrides", () => {
  it("carries every override key, set or not", () => {
    const picked = pickAgentOverrides({ providerId: "openai" })
    expect(Object.keys(picked).sort()).toEqual([...AGENT_OVERRIDE_FIELDS].sort())
    expect(picked.providerId).toBe("openai")
    expect(picked.toolFilter).toBeUndefined()
  })

  it("passes values through by reference and ignores non-override fields", () => {
    const toolFilter = { mode: "deny" as const, tools: ["Bash"] }
    const character = {
      id: "c1",
      name: "n",
      systemPrompt: "p",
      avatarColor: "#000",
      createdAt: 0,
      updatedAt: 0,
      toolFilter,
      enableOcr: false,
    } satisfies Character
    const picked = pickAgentOverrides(character)
    expect(picked.toolFilter).toBe(toolFilter)
    expect(picked.enableOcr).toBe(false)
    expect(picked).not.toHaveProperty("name")
  })

  it("does not list the fields no runtime path reads", () => {
    expect(AGENT_OVERRIDE_FIELDS).not.toContain("embeddingProviderId")
    expect(AGENT_OVERRIDE_FIELDS).not.toContain("a2uiCatalogId")
  })

  it("counts only the fields that override a default", () => {
    expect(countAgentOverrides(emptyAgentOverrides())).toBe(0)
    expect(
      countAgentOverrides(
        pickAgentOverrides({ enableOcr: false, maxThinkingTokens: 0, outputStyle: "default" })
      )
    ).toBe(3)
  })
})
