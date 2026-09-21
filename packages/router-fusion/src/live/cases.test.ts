import { RunRequestSchema } from "../contracts/schemas"
import { fakeCompiledConfig, fixtureRouteRequest } from "../fake/route-fixtures"
import { routeAction } from "../routing/action-router"
import {
  caseRunRequest,
  classifyRouteRefusal,
  DELEGATE_FIXTURE_FILES,
  FIXTURE_ACCEPTANCE_PROFILE_ID,
  LIVE_SMOKE_CASE_IDS,
  LIVE_SMOKE_CASES,
  MODE_UNAVAILABLE_EXCLUSIONS,
} from "./cases"

const WORKSPACE = "33333333-3333-4333-8333-333333333333"

describe("live smoke cases", () => {
  it("has exactly one case per execution mode, in the documented order", () => {
    expect(LIVE_SMOKE_CASES.map((c) => c.id)).toEqual([...LIVE_SMOKE_CASE_IDS])
    expect(LIVE_SMOKE_CASES.map((c) => c.mode)).toEqual(["direct", "cascade", "panel", "delegate"])
  })

  it("asks only as the user, and only the delegate case uses the fixture repository", () => {
    for (const definition of LIVE_SMOKE_CASES) {
      expect(definition.messages.every((m) => m.role === "user")).toBe(true)
      expect(definition.usesFixtureRepo).toBe(definition.mode === "delegate")
    }
  })

  it("builds a contract-valid RunRequest for every case", () => {
    for (const definition of LIVE_SMOKE_CASES) {
      const request = caseRunRequest(definition, {
        capMicrousd: 400_000,
        budgetMode: "strict",
        workspaceId: WORKSPACE,
      })
      expect(RunRequestSchema.parse(request)).toEqual(request)
      expect(request).toMatchObject({
        mode: definition.mode,
        allowed_modes: [definition.mode],
        budget: { max_cost_usd: "0.400000", mode: "strict" },
        allow_degraded: definition.allowDegraded,
        delivery: "verified_buffered",
      })
    }
  })

  it("names the fixture workspace and its acceptance profile on the delegate request only", () => {
    const delegate = LIVE_SMOKE_CASES.find((c) => c.mode === "delegate")!
    const direct = LIVE_SMOKE_CASES.find((c) => c.mode === "direct")!
    const options = { capMicrousd: 1, budgetMode: "strict" as const, workspaceId: WORKSPACE }
    expect(caseRunRequest(delegate, options)).toMatchObject({
      workspace_id: WORKSPACE,
      acceptance_profile_id: FIXTURE_ACCEPTANCE_PROFILE_ID,
    })
    expect(caseRunRequest(direct, options)).not.toHaveProperty("workspace_id")
    expect(caseRunRequest(delegate, { capMicrousd: 1, budgetMode: "strict" })).not.toHaveProperty(
      "workspace_id"
    )
  })

  it("accepts a degraded result only where the request says so (the panel, which has no evidence tool)", () => {
    expect(LIVE_SMOKE_CASES.filter((c) => c.allowDegraded).map((c) => c.id)).toEqual(["panel"])
  })

  it("ships a fixture repository whose acceptance profile runs its own tests into a JUnit report", () => {
    const config = JSON.parse(DELEGATE_FIXTURE_FILES[".cognia/workspace.json"]) as {
      version: number
      acceptanceProfiles: Record<
        string,
        { command: string[]; report: { format: string; path: string }; requiredTests: string[] }
      >
    }
    expect(config.version).toBe(1)
    const profile = config.acceptanceProfiles[FIXTURE_ACCEPTANCE_PROFILE_ID]
    expect(profile.report).toEqual({ format: "junit", path: "junit.xml" })
    expect(profile.command).toContain("--test-reporter=junit")
    expect(profile.command).toContain("test/slugify.test.mjs")
    const tests = DELEGATE_FIXTURE_FILES["test/slugify.test.mjs"]
    for (const name of profile.requiredTests) expect(tests).toContain(`test("${name}"`)
    // The bug the delegate case asks to fix: no lowercasing.
    expect(DELEGATE_FIXTURE_FILES["src/slugify.mjs"]).not.toContain("toLowerCase")
    expect(JSON.parse(DELEGATE_FIXTURE_FILES["package.json"])).toMatchObject({ type: "module" })
  })
})

describe("classifyRouteRefusal", () => {
  const config = fakeCompiledConfig()

  it("skips a mode the router excludes for a missing host capability", () => {
    const result = routeAction(
      config,
      fixtureRouteRequest({
        requestedMode: "delegate",
        allowedModes: ["delegate"],
        capabilities: {
          sandboxTier: null,
          acceptanceProfileAvailable: false,
          verifierProfiles: ["text_basic"],
          webToolsAvailable: false,
        },
      })
    )
    expect(result.selected).toBeNull()
    const refusal = classifyRouteRefusal("delegate", { reasons: [], decision: result.decision })
    expect(refusal.kind).toBe("skipped")
    expect(refusal.detail).toBe("skipped: delegate not available in this build")
    expect(refusal.reasons).toEqual(expect.arrayContaining(["delegate_code:SANDBOX_UNAVAILABLE"]))
    // Only the requested mode's own candidates speak for it.
    expect(refusal.reasons.some((reason) => reason.startsWith("direct_baseline:"))).toBe(false)
  })

  it("refuses, not skips, when the mode is available but this request does not fit", () => {
    const result = routeAction(
      config,
      fixtureRouteRequest({
        requestedMode: "direct",
        allowedModes: ["direct"],
        runAvailableMicrousd: 1,
      })
    )
    expect(result.selected).toBeNull()
    const refusal = classifyRouteRefusal("direct", { reasons: [], decision: result.decision })
    expect(refusal.kind).toBe("refused")
    expect(refusal.reasons).toEqual(
      expect.arrayContaining(["direct_baseline:BUDGET_EXCEEDS_RUN_AVAILABLE"])
    )
  })

  it("refuses with the route's own reasons when no candidate of the mode was assessed", () => {
    const refusal = classifyRouteRefusal("panel", {
      reasons: ["NO_CANDIDATES:alias:balanced", "panel_review:alias_missing:balanced"],
      decision: null,
    })
    expect(refusal).toEqual({
      kind: "refused",
      detail: "refused: the router found no panel action",
      reasons: ["NO_CANDIDATES:alias:balanced", "panel_review:alias_missing:balanced"],
    })
  })

  it("treats only host-capability exclusions as 'not available'", () => {
    expect([...MODE_UNAVAILABLE_EXCLUSIONS].sort()).toEqual(
      ["MODE_NOT_ALLOWED", "SANDBOX_UNAVAILABLE", "VERIFIER_UNAVAILABLE"].sort()
    )
  })
})
