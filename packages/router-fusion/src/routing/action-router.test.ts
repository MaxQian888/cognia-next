import { RouteDecisionSchema } from "../contracts/schemas"
import { SPEC_MOCK_REGISTRY, fakeTierRegistry } from "../fake/mock-registry"
import { fakeCompiledConfig, fixtureFeatures, fixtureRouteRequest } from "../fake/route-fixtures"
import { routeAction } from "./action-router"
import type { DeploymentSelector } from "./deployment-filter"

function candidate(result: ReturnType<typeof routeAction>, actionId: string) {
  const found = result.decision.candidates.find((c) => c.action_id === actionId)
  if (!found) throw new Error(`no candidate ${actionId}`)
  return found
}

describe("routeAction", () => {
  const config = fakeCompiledConfig()

  it("[ACC:ROUTE-01] picks the baseline for an unknown task with no predictor and never invents a score", () => {
    const result = routeAction(
      config,
      fixtureRouteRequest({ features: fixtureFeatures({ task: "unknown", ambiguity: "unknown" }) })
    )
    expect(result.decision.selected_action_id).toBe("direct_baseline")
    expect(result.ruleId).toBe("R6_baseline")
    for (const assessed of result.decision.candidates) {
      expect(assessed.quality.p_pass).toBeNull()
      expect(assessed.quality.source).toBe("rule")
    }
    expect(RouteDecisionSchema.parse(result.decision)).toEqual(result.decision)
  })

  it("[ACC:ROUTE-06] assesses every action with its real exclusion reasons and versions", () => {
    const result = routeAction(config, fixtureRouteRequest())
    expect(result.decision.candidates.map((c) => c.action_id)).toEqual([
      "direct_baseline",
      "direct_economy",
      "cascade_schema",
      "cascade_code",
      "panel_review",
      "delegate_code",
      "cascade_review",
    ])
    expect(candidate(result, "direct_economy").exclusion_reasons).toContain("RULE_NOT_MATCHED")
    expect(candidate(result, "direct_baseline").eligible).toBe(true)
    expect(candidate(result, "direct_baseline").reserve_cost_microusd).toBeGreaterThan(0)
    expect(result.decision.policy_version).toBe("cognia-policy-1")
    expect(result.decision.registry_version).toBe("mock-tiers-1")
    expect(result.decision.classifier_version).toBe("rules-1")
    expect(result.decision.reason_codes).toEqual(
      expect.arrayContaining(["rule:R6_baseline", "budget:tracked"])
    )
    const details = result.details.find((d) => d.actionId === "panel_review")
    expect(details?.roles).toEqual({
      panel_a: "fake-economy",
      panel_b: "fake-independent",
      judge: "fake-baseline",
      synthesizer: "fake-baseline",
    })
  })

  it("keeps an approved-row action out of auto until the user approves the row (D11)", () => {
    const features = fixtureFeatures({ task: "text.transform" })
    const unapproved = routeAction(config, fixtureRouteRequest({ features }))
    expect(unapproved.decision.selected_action_id).toBe("direct_baseline")
    expect(candidate(unapproved, "direct_economy").exclusion_reasons).toContain(
      "RULE_ROW_NOT_APPROVED"
    )

    const approved = routeAction(
      config,
      fixtureRouteRequest({ features, approvedRuleRows: ["economy_simple"] })
    )
    expect(approved.decision.selected_action_id).toBe("direct_economy")
    expect(approved.ruleId).toBe("R2_economy_simple")
  })

  it("routes research to the panel and multi-file code to delegate only when approved and capable", () => {
    const research = routeAction(
      config,
      fixtureRouteRequest({
        features: fixtureFeatures({ task: "research.synthesis" }),
        approvedRuleRows: ["panel_research"],
      })
    )
    expect(research.decision.selected_action_id).toBe("panel_review")
    expect(research.decision.mode_selected).toBe("panel")

    const codeFeatures = fixtureFeatures({
      task: "code.implement",
      scope: "multi_file",
      tool_need: "sandbox_write",
    })
    const delegate = routeAction(
      config,
      fixtureRouteRequest({
        features: codeFeatures,
        approvedRuleRows: ["delegate_multifile"],
        deliversChange: true,
      })
    )
    expect(delegate.decision.selected_action_id).toBe("delegate_code")

    const noSandbox = routeAction(
      config,
      fixtureRouteRequest({
        features: codeFeatures,
        approvedRuleRows: ["delegate_multifile"],
        deliversChange: true,
        capabilities: { ...fixtureRouteRequest().capabilities, sandboxTier: null },
      })
    )
    expect(candidate(noSandbox, "delegate_code").exclusion_reasons).toContain("SANDBOX_UNAVAILABLE")
  })

  it("[ACC:ROUTE-02] excludes the cheapest deployment that cannot read the input modality before comparing cost", () => {
    const registry = fakeTierRegistry()
    registry.deployments = registry.deployments.map((d) =>
      d.id === "fake-economy" ? { ...d, inputModalities: ["text"] } : d
    )
    const textOnlyEconomy = fakeCompiledConfig({ registry })
    const result = routeAction(
      textOnlyEconomy,
      fixtureRouteRequest({
        inputModalities: ["text", "image"],
        features: fixtureFeatures({ task: "text.transform" }),
        approvedRuleRows: ["economy_simple"],
      })
    )
    expect(candidate(result, "direct_economy").eligible).toBe(false)
    expect(candidate(result, "direct_economy").exclusion_reasons).toEqual(
      expect.arrayContaining([
        "ROLE_UNRESOLVABLE:solver",
        "solver:fake-economy:MODALITY_UNSUPPORTED",
      ])
    )
    expect(result.decision.selected_action_id).toBe("direct_baseline")
  })

  it("[ACC:ROUTE-08] fails plainly when no action fits the data scope and budget", () => {
    const registry = fakeTierRegistry()
    registry.deployments = registry.deployments.map((d) => ({ ...d, dataClasses: ["public"] }))
    const result = routeAction(
      fakeCompiledConfig({ registry }),
      fixtureRouteRequest({
        dataPolicy: { ...fixtureRouteRequest().dataPolicy, dataClass: "internal" },
      })
    )
    expect(result.decision.selected_action_id).toBeNull()
    expect(result.decision.mode_selected).toBeNull()
    expect(result.decision.reason_codes).toContain("NO_ELIGIBLE_ACTION")

    const broke = routeAction(config, fixtureRouteRequest({ runAvailableMicrousd: 1 }))
    expect(broke.decision.selected_action_id).toBeNull()
    expect(candidate(broke, "direct_baseline").exclusion_reasons).toContain(
      "BUDGET_EXCEEDS_RUN_AVAILABLE"
    )
  })

  it("[ACC:AUTH-04] refuses restricted data for every role without a grant", () => {
    const registry = fakeTierRegistry()
    registry.deployments = registry.deployments.map((d) => ({
      ...d,
      providerId: "cloud",
      exampleOnly: true,
      cacheMode: "automatic" as const,
    }))
    const restricted = fixtureRouteRequest({
      dataPolicy: {
        dataClass: "restricted",
        restrictedGrantProviderIds: [],
        revokedDeploymentIds: [],
      },
    })
    const result = routeAction(fakeCompiledConfig({ registry }), restricted)
    expect(result.decision.selected_action_id).toBeNull()
    expect(candidate(result, "direct_baseline").exclusion_reasons).toContain(
      "solver:fake-baseline:RESTRICTED_NOT_GRANTED"
    )

    const granted = routeAction(fakeCompiledConfig({ registry }), {
      ...restricted,
      dataPolicy: { ...restricted.dataPolicy, restrictedGrantProviderIds: ["cloud"] },
    })
    expect(granted.decision.selected_action_id).toBe("direct_baseline")
  })

  it("[ACC:AUTH-07] stops routing to a deployment the moment its permission is revoked", () => {
    const result = routeAction(
      config,
      fixtureRouteRequest({
        dataPolicy: {
          ...fixtureRouteRequest().dataPolicy,
          revokedDeploymentIds: ["fake-baseline"],
        },
      })
    )
    expect(candidate(result, "direct_baseline").exclusion_reasons).toContain(
      "solver:fake-baseline:CREDENTIAL_REVOKED"
    )
    expect(result.decision.selected_action_id).toBeNull()
  })

  it("[ACC:CACHE-01] re-checks live health on every decision", () => {
    const healthy = routeAction(config, fixtureRouteRequest())
    const down = routeAction(
      config,
      fixtureRouteRequest({ health: { "fake-baseline": "unavailable" } })
    )
    expect(healthy.decision.selected_action_id).toBe("direct_baseline")
    expect(down.decision.selected_action_id).toBeNull()
    expect(candidate(down, "direct_baseline").exclusion_reasons).toContain(
      "solver:fake-baseline:DEPLOYMENT_UNAVAILABLE"
    )
  })

  it("excludes unaudited prices, estimated billing and hidden retries only under a strict budget", () => {
    const registry = fakeTierRegistry()
    registry.deployments = registry.deployments.map((d) =>
      d.id === "fake-baseline"
        ? {
            ...d,
            rateCardId: null,
            billingTransparency: "estimated" as const,
            internalRetry: "hidden" as const,
          }
        : d
    )
    const compiled = fakeCompiledConfig({ registry })
    const tracked = routeAction(compiled, fixtureRouteRequest())
    expect(tracked.decision.selected_action_id).toBe("direct_baseline")
    expect(tracked.decision.reason_codes).toContain("price:estimated")

    const strict = routeAction(compiled, fixtureRouteRequest({ budgetMode: "strict" }))
    expect(candidate(strict, "direct_baseline").exclusion_reasons).toEqual(
      expect.arrayContaining([
        "solver:fake-baseline:PRICE_NOT_AUDITED",
        "solver:fake-baseline:BILLING_NOT_BOUNDED",
        "solver:fake-baseline:HIDDEN_RETRIES",
      ])
    )
  })

  it("never lets a panel use the same model revision twice", () => {
    const policy = fakeCompiledConfig().policy
    const actions = policy.actions.map((a) =>
      a.id === "panel_review" ? { ...a, roles: { ...a.roles, panel_b: "fast" } } : { ...a }
    )
    const compiled = fakeCompiledConfig({ policy: { ...structuredClone(policy), actions } })
    const result = routeAction(
      compiled,
      fixtureRouteRequest({ requestedMode: "panel", allowedModes: ["panel"] })
    )
    expect(candidate(result, "panel_review").exclusion_reasons).toContain("PANEL_SAME_REVISION")
    expect(result.decision.selected_action_id).toBeNull()
  })

  it("honours an explicit mode without drifting to another mode", () => {
    const panel = routeAction(
      config,
      fixtureRouteRequest({ requestedMode: "panel", allowedModes: ["panel"] })
    )
    expect(panel.decision.selected_action_id).toBe("panel_review")
    expect(candidate(panel, "direct_baseline").exclusion_reasons).toEqual(
      expect.arrayContaining(["MODE_NOT_ALLOWED", "MODE_NOT_REQUESTED"])
    )
    const economy = routeAction(
      config,
      fixtureRouteRequest({ requestedMode: "direct", profile: "economy" })
    )
    expect(economy.decision.selected_action_id).toBe("direct_economy")
    const quality = routeAction(
      config,
      fixtureRouteRequest({ requestedMode: "direct", profile: "quality" })
    )
    expect(quality.decision.selected_action_id).toBe("direct_baseline")
  })

  it("refuses fusion modes under a fusion ancestor (INV-09)", () => {
    const result = routeAction(
      config,
      fixtureRouteRequest({
        requestedMode: "panel",
        allowedModes: ["panel"],
        hasFusionAncestor: true,
      })
    )
    expect(candidate(result, "panel_review").exclusion_reasons).toContain("FUSION_RECURSION")
  })

  it("[ACC:PROF-01] will not let a change-delivering code task be accepted by a text_basic action", () => {
    const features = fixtureFeatures({ task: "code.implement", scope: "single_file" })
    const result = routeAction(
      config,
      fixtureRouteRequest({
        features,
        deliversChange: true,
        requestedActionId: "direct_baseline",
        requestedAcceptanceProfile: "text_basic",
      })
    )
    expect(candidate(result, "direct_baseline").exclusion_reasons).toContain(
      "PROFILE_BELOW_TASK_MINIMUM"
    )
    expect(result.decision.selected_action_id).toBeNull()

    const cascade = routeAction(
      config,
      fixtureRouteRequest({
        features,
        deliversChange: true,
        requestedActionId: "cascade_code",
        requestedAcceptanceProfile: "text_basic",
      })
    )
    expect(cascade.decision.selected_action_id).toBe("cascade_code")
    expect(cascade.acceptanceProfile).toBe("code_fixture")
    expect(cascade.acceptanceProfileRaised).toBe(true)
    expect(cascade.decision.reason_codes).toContain("acceptance:raised_to_minimum")
  })

  it("pauses for input instead of guessing when information is missing", () => {
    const result = routeAction(
      config,
      fixtureRouteRequest({
        features: fixtureFeatures({ missing_information: ["workspace_not_bound"] }),
      })
    )
    expect(result.needsInput).toBe(true)
    expect(result.ruleId).toBe("R0_needs_input")
    expect(result.decision.selected_action_id).toBeNull()
    expect(result.decision.reason_codes).toContain("NEEDS_INPUT")
  })

  it("keeps a pinned manual deployment as a hard override", () => {
    const pinned = routeAction(
      config,
      fixtureRouteRequest({
        requestedActionId: "direct_baseline",
        roleDeploymentOverrides: { solver: "fake-independent" },
      })
    )
    expect(pinned.selected?.roles.solver).toBe("fake-independent")

    const revoked = routeAction(
      config,
      fixtureRouteRequest({
        requestedActionId: "direct_baseline",
        roleDeploymentOverrides: { solver: "fake-independent" },
        dataPolicy: {
          ...fixtureRouteRequest().dataPolicy,
          revokedDeploymentIds: ["fake-independent"],
        },
      })
    )
    expect(revoked.decision.selected_action_id).toBeNull()
    const missing = routeAction(
      config,
      fixtureRouteRequest({
        requestedActionId: "direct_baseline",
        roleDeploymentOverrides: { solver: "ghost" },
      })
    )
    expect(candidate(missing, "direct_baseline").exclusion_reasons).toContain(
      "ROLE_UNRESOLVABLE:solver"
    )
  })

  it("re-checks whatever an injected selector returns", () => {
    const sneaky: DeploymentSelector = (input) => ({
      deployment: input.context.config.deploymentsById["fake-baseline"],
      rejected: [],
      affinityKept: false,
    })
    const result = routeAction(
      config,
      fixtureRouteRequest({ health: { "fake-baseline": "unavailable" } }),
      sneaky
    )
    expect(result.decision.selected_action_id).toBeNull()
    expect(candidate(result, "direct_baseline").exclusion_reasons).toContain(
      "solver:fake-baseline:DEPLOYMENT_UNAVAILABLE"
    )
  })

  it("prices a candidate for the selector that asks, at this request's token sizes", () => {
    const quoted: Array<{ id: string; microusd: number | null }> = []
    const pricing: DeploymentSelector = (input) => {
      const deployment = input.context.config.deploymentsById["fake-baseline"]
      if (deployment) quoted.push({ id: deployment.id, microusd: input.expectedCost(deployment) })
      return { deployment, rejected: [], affinityKept: false }
    }
    routeAction(config, fixtureRouteRequest({ estimatedInputTokens: 100_000 }), pricing)
    expect(quoted.length).toBeGreaterThan(0)
    expect(quoted[0]).toMatchObject({ id: "fake-baseline" })
    expect(quoted[0].microusd ?? 0).toBeGreaterThan(0)
    // The same deployment costs less on a smaller prompt.
    const cheaper: Array<number | null> = []
    routeAction(config, fixtureRouteRequest({ estimatedInputTokens: 10 }), (input) => {
      const deployment = input.context.config.deploymentsById["fake-baseline"]
      if (deployment) cheaper.push(input.expectedCost(deployment))
      return { deployment, rejected: [], affinityKept: false }
    })
    expect(cheaper[0] ?? 0).toBeLessThan(quoted[0].microusd ?? 0)
  })

  it("reports grouped eval evidence without inventing an individual probability, keyed by action hash", () => {
    const hash = config.actions.direct_baseline.actionHash
    const result = routeAction(
      config,
      fixtureRouteRequest({ evalEvidence: { [hash]: { groupPassRate: 0.8, supportCount: 120 } } })
    )
    expect(candidate(result, "direct_baseline").quality).toEqual({
      action_id: "direct_baseline",
      p_pass: null,
      group_pass_rate: 0.8,
      source: "eval",
      support_count: 120,
      in_distribution: true,
      predictor_version: null,
    })
  })

  it("excludes an action whose estimated latency exceeds the remaining deadline", () => {
    const result = routeAction(config, fixtureRouteRequest({ deadlineRemainingMs: 100 }))
    expect(candidate(result, "direct_baseline").exclusion_reasons).toContain("DEADLINE_EXCEEDED")
  })

  it("compiles against the spec mock registry aliases too", () => {
    expect(SPEC_MOCK_REGISTRY.aliases.economy).toEqual(["fake-economy"])
  })
})
