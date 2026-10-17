import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"

import { bestOfNEstimateQueries } from "./estimate-queries"

describe("bestOfNEstimateQueries", () => {
  const session = { model: "claude-sonnet-4-5", providerOverride: "anthropic" }

  it("collapses identical choices into one query with a multiplier", () => {
    expect(bestOfNEstimateQueries(session, ["session", "session", "session"])).toEqual([
      { surface: "best-of-n", model: "claude-sonnet-4-5", providerId: "anthropic", multiplier: 3 },
    ])
  })

  it("keys external choices on their configuration's provider marker", () => {
    expect(bestOfNEstimateQueries({}, ["session", "cfg", "cfg"])).toEqual([
      { surface: "best-of-n", model: null, providerId: null, multiplier: 1 },
      { surface: "best-of-n", providerId: externalAgentProviderId("cfg"), multiplier: 2 },
    ])
  })
})
