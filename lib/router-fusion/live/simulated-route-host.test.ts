/** @jest-environment jsdom */
import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import { caseRunRequest, LIVE_SMOKE_CASES } from "@cognia/router-fusion/live/cases"

import { liveRefusalFor } from "../chat/route-chat-turn"
import { routeRunRequest } from "../routing/run-route"
import { createSimulatedRouteHost, simulatedAppSettings } from "./simulated-route-host"

let counter = 0
const deps = {
  now: () => Date.parse("2026-09-19T00:00:00Z"),
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
}

describe("simulatedAppSettings", () => {
  it("is the app's defaults with Router + Fusion on for the gateway-runs surface only", () => {
    const settings = simulatedAppSettings()
    expect(settings.routerFusion?.enabled).toBe(true)
    expect(settings.routerFusion?.surfaces).toMatchObject({ gatewayRuns: true, chat: false })
    expect(settings.providerSettings).toBeUndefined()
  })
})

describe("createSimulatedRouteHost", () => {
  const host = createSimulatedRouteHost(simulatedAppSettings(), deps)

  it("resolves each routing tier to one priced Fake Provider deployment", async () => {
    const base = { surface: "gateway" as const, sessionId: "s" }
    for (const [alias, modelId] of [
      ["fast", "mock/economy-v1"],
      ["balanced", "mock/independent-v1"],
      ["powerful", "mock/baseline-v1"],
    ]) {
      const plan = await host.planRoute({ ...base, selection: { kind: "alias", alias } })
      expect(plan.orderedCandidates.map((c) => `${c.providerId}::${c.modelId}`)).toEqual([
        `fake::${modelId}`,
      ])
      expect(host.pricingOf("fake", modelId)).toEqual(
        expect.objectContaining({ promptPer1M: expect.any(Number) })
      )
    }
    await expect(
      host.planRoute({ ...base, selection: { kind: "alias", alias: "coding" } })
    ).rejects.toBeInstanceOf(RoutingNoCandidatesError)
    expect(host.pricingOf("openai", "gpt-4o")).toBeNull()
    expect(host.environment).toBe("development")
  })

  it("lets the orchestrator's live check call a simulated deployment", () => {
    expect(liveRefusalFor(host, "fake::mock/economy-v1", "internal", "gatewayRuns")).toBeNull()
    expect(liveRefusalFor(host, "openai::gpt-4o", "internal", "gatewayRuns")).toBe(
      "PROVIDER_UNAVAILABLE"
    )
  })

  it("routes every case through the real ActionRouter", async () => {
    const outcomes: Record<string, string> = {}
    for (const definition of LIVE_SMOKE_CASES) {
      const runId = deps.newId()
      const route = await routeRunRequest(host, {
        runId,
        decisionId: deps.newId(),
        request: caseRunRequest(definition, {
          capMicrousd: 1_000_000,
          budgetMode: "strict",
          workspaceId: deps.newId(),
        }),
        messages: definition.messages,
        jsonSchema: definition.jsonSchema,
        sessionId: runId,
        webToolsAvailable: false,
        executableModes: ["direct", "cascade", "panel", "delegate"],
      })
      outcomes[definition.id] = route.kind === "selected" ? route.actionId : route.kind
    }
    expect(outcomes).toEqual({
      direct: "direct_baseline",
      cascade: "cascade_schema",
      panel: "panel_review",
      delegate: "refused",
    })
  })
})
