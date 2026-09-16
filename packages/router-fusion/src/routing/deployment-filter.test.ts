import { fakeCompiledConfig } from "../fake/route-fixtures"
import { fakeTierRegistry } from "../fake/mock-registry"
import {
  deploymentExclusions,
  selectDeploymentInAliasOrder,
  type DeploymentFilterContext,
  type RoleRequirements,
} from "./deployment-filter"

const REQUIREMENTS: RoleRequirements = {
  inputModalities: ["text"],
  needsTools: false,
  needsJsonSchema: false,
  inputTokens: 1000,
  outputTokens: 1000,
}

function context(overrides: Partial<DeploymentFilterContext> = {}): DeploymentFilterContext {
  return {
    config: fakeCompiledConfig(),
    budgetMode: "tracked",
    health: {},
    policy: { dataClass: "internal", restrictedGrantProviderIds: [], revokedDeploymentIds: [] },
    ...overrides,
  }
}

describe("deploymentExclusions", () => {
  it("passes a capable, healthy, priced deployment", () => {
    const ctx = context()
    expect(
      deploymentExclusions(ctx.config.deploymentsById["fake-economy"], REQUIREMENTS, ctx)
    ).toEqual([])
  })

  it("reports every failed constraint, not just the first", () => {
    const registry = fakeTierRegistry()
    registry.deployments[0] = {
      ...registry.deployments[0],
      enabled: false,
      supportsTools: false,
      supportsJsonSchema: false,
      contextLimit: 1500,
      inputModalities: ["text"],
    }
    const ctx = context({
      config: fakeCompiledConfig({ registry }),
      health: { "fake-economy": "unavailable" },
      policy: {
        dataClass: "internal",
        excludedProviderIds: ["fake"],
        allowedProviderIds: ["other"],
        restrictedGrantProviderIds: [],
        revokedDeploymentIds: ["fake-economy"],
      },
    })
    expect(
      deploymentExclusions(
        ctx.config.deploymentsById["fake-economy"],
        {
          ...REQUIREMENTS,
          inputModalities: ["text", "image"],
          needsTools: true,
          needsJsonSchema: true,
        },
        ctx
      )
    ).toEqual([
      "DEPLOYMENT_DISABLED",
      "CREDENTIAL_REVOKED",
      "DEPLOYMENT_UNAVAILABLE",
      "PROVIDER_EXCLUDED",
      "PROVIDER_NOT_ALLOWED",
      "MODALITY_UNSUPPORTED",
      "TOOLS_UNSUPPORTED",
      "JSON_SCHEMA_UNSUPPORTED",
      "CONTEXT_TOO_SMALL",
    ])
  })

  it("refuses example rate cards in a strict production budget", () => {
    const ctx = context({
      budgetMode: "strict",
      config: { ...fakeCompiledConfig(), environment: "production" },
    })
    expect(
      deploymentExclusions(ctx.config.deploymentsById["fake-economy"], REQUIREMENTS, ctx)
    ).toContain("PRICE_NOT_AUDITED")
  })
})

describe("selectDeploymentInAliasOrder", () => {
  function registryWithTwoFast(costlyFirst: { first: string; second: string }) {
    const registry = fakeTierRegistry()
    const second = {
      ...registry.deployments[0],
      id: "fake-economy-2",
      modelRevision: "mock/economy-v2",
    }
    registry.deployments.push(second)
    registry.rate_cards.push({
      ...registry.rate_cards[0],
      id: "rate-2",
      ordinary_input_per_million: costlyFirst.second,
      output_per_million: costlyFirst.second,
    })
    registry.deployments[3] = { ...second, rateCardId: "rate-2" }
    registry.rate_cards[0] = {
      ...registry.rate_cards[0],
      ordinary_input_per_million: costlyFirst.first,
      output_per_million: costlyFirst.first,
    }
    registry.aliases.fast = ["fake-economy", "fake-economy-2"]
    return registry
  }

  function select(
    registryInput: ReturnType<typeof fakeTierRegistry>,
    affinity?: string,
    revoked: string[] = []
  ) {
    const config = fakeCompiledConfig({ registry: registryInput })
    const ctx = context({
      config,
      policy: {
        dataClass: "internal",
        restrictedGrantProviderIds: [],
        revokedDeploymentIds: revoked,
      },
    })
    return selectDeploymentInAliasOrder({
      alias: "fast",
      role: "solver",
      requirements: REQUIREMENTS,
      context: ctx,
      affinityDeploymentId: affinity,
      switchMargin: 0.15,
      expectedCost: (deployment) => {
        const card = config.rateCardsById[deployment.rateCardId ?? ""]
        return card ? Math.round(Number(card.ordinary_input_per_million) * 1000) : null
      },
    })
  }

  it("uses alias order without affinity", () => {
    expect(select(registryWithTwoFast({ first: "1.00", second: "0.50" })).deployment?.id).toBe(
      "fake-economy"
    )
  })

  it("[ACC:ROUTE-07] keeps the session's deployment when the alternative is only 5% cheaper", () => {
    const result = select(registryWithTwoFast({ first: "1.00", second: "0.95" }), "fake-economy")
    expect(result.deployment?.id).toBe("fake-economy")
    expect(result.affinityKept).toBe(true)
  })

  it("switches when the saving beats the 15% margin", () => {
    const result = select(registryWithTwoFast({ first: "1.00", second: "0.50" }), "fake-economy")
    expect(result.deployment?.id).toBe("fake-economy-2")
    expect(result.affinityKept).toBe(false)
  })

  it("[ACC:ROUTE-07] must leave the session's deployment once its permission is revoked", () => {
    const result = select(registryWithTwoFast({ first: "1.00", second: "0.95" }), "fake-economy", [
      "fake-economy",
    ])
    expect(result.deployment?.id).toBe("fake-economy-2")
    expect(result.rejected).toEqual([
      { deploymentId: "fake-economy", reasons: ["CREDENTIAL_REVOKED"] },
    ])
  })

  it("returns no deployment when the alias has none eligible", () => {
    const result = select(registryWithTwoFast({ first: "1.00", second: "1.00" }), undefined, [
      "fake-economy",
      "fake-economy-2",
    ])
    expect(result.deployment).toBeNull()
    expect(result.rejected).toHaveLength(2)
  })
})
