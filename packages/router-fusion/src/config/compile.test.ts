import { readFileSync } from "node:fs"
import { join } from "node:path"

import { parse } from "yaml"

import { PolicyConfigSchema, type PolicyConfig } from "../contracts/schemas"
import { SPEC_MOCK_REGISTRY, fakeTierRegistry } from "../fake/mock-registry"
import {
  BUILTIN_ACTIONS,
  DEFAULT_LIMITS_BY_MODE,
  builtinExtensions,
  builtinPolicy,
  defaultExtension,
} from "./builtin-catalog"
import { ConfigCompileError, compileFusionConfig } from "./compile"
import type { FusionConfigInput } from "./types"

const SPEC_DIR = join(__dirname, "..", "contracts", "spec")

function input(overrides: Partial<FusionConfigInput> = {}): FusionConfigInput {
  return {
    policy: builtinPolicy(),
    registry: fakeTierRegistry(),
    extensions: builtinExtensions(),
    environment: "development",
    ...overrides,
  }
}

function compileIssues(value: FusionConfigInput): Array<{ pointer: string; message: string }> {
  try {
    compileFusionConfig(value)
  } catch (error) {
    if (error instanceof ConfigCompileError) return error.issues
    throw error
  }
  return []
}

describe("builtin catalog", () => {
  it("ships the six D17 actions with baseline first, then B3's review cascade", () => {
    expect(BUILTIN_ACTIONS.map((a) => a.id)).toEqual([
      "direct_baseline",
      "direct_economy",
      "cascade_schema",
      "cascade_code",
      "panel_review",
      "delegate_code",
      "cascade_review",
    ])
    // The review cascade comes after the schema cascade, so a schema still wins.
    const cascades = BUILTIN_ACTIONS.filter((a) => a.mode === "cascade").map((a) => a.id)
    expect(cascades.indexOf("cascade_schema")).toBeLessThan(cascades.indexOf("cascade_review"))
    expect(BUILTIN_ACTIONS.find((a) => a.id === "cascade_review")?.verifier_profile).toBe(
      "text_review"
    )
    expect(builtinPolicy().production_auto_baseline_only).toBe(true)
  })

  it("keeps ordinary chat's agentic budget and the spec limits for fusion modes", () => {
    expect(DEFAULT_LIMITS_BY_MODE.direct).toMatchObject({
      max_model_calls: 256,
      deadline_ms: 3_600_000,
    })
    expect(DEFAULT_LIMITS_BY_MODE.panel).toMatchObject({
      max_model_calls: 24,
      deadline_ms: 120_000,
    })
    expect(DEFAULT_LIMITS_BY_MODE.delegate).toMatchObject({
      max_model_calls: 24,
      deadline_ms: 900_000,
    })
    expect(defaultExtension("direct").run_cap_microusd).toBe(500_000)
    expect(defaultExtension("delegate").run_cap_microusd).toBe(5_000_000)
    expect(defaultExtension("panel").web_tools_enabled).toBe(true)
    expect(defaultExtension("direct").web_tools_enabled).toBe(false)
  })

  it("produces a contract-valid policy", () => {
    expect(PolicyConfigSchema.safeParse(builtinPolicy()).success).toBe(true)
  })
})

describe("compileFusionConfig", () => {
  it("compiles the builtin catalog against the fake tier registry outside production", () => {
    const compiled = compileFusionConfig(input())
    expect(Object.keys(compiled.actions)).toHaveLength(7)
    expect(compiled.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.actions.direct_baseline.extension.limits)).toBe(true)
  })

  it("[ACC:CFG-01] refuses fake providers and example rates in production", () => {
    const issues = compileIssues(input({ environment: "production" }))
    const pointers = issues.map((i) => i.pointer)
    expect(pointers).toContain("/registry/example_only")
    expect(pointers).toContain("/registry/deployments/0")
    expect(pointers).toContain("/registry/rate_cards/0/example_only")
  })

  it("[ACC:CFG-02] names the exact field of an unresolvable role alias", () => {
    const policy = builtinPolicy()
    policy.actions[4] = {
      ...policy.actions[4],
      roles: { ...policy.actions[4].roles, judge: "missing-tier" },
    }
    const issues = compileIssues(input({ policy }))
    expect(issues).toContainEqual({
      pointer: "/policy/actions/4/roles/judge",
      message: "alias missing-tier does not exist in the registry",
    })
  })

  it("reports missing required roles, foreign roles, bad verifiers and dangling references", () => {
    const policy = builtinPolicy()
    policy.actions[0] = {
      ...policy.actions[0],
      roles: { lead: "powerful" },
      verifier_profile: "vibes",
    }
    policy.actions[5] = { ...policy.actions[5], verifier_profile: "text_basic" }
    const registry = fakeTierRegistry()
    registry.aliases.fast = ["nope"]
    registry.deployments = [
      { ...registry.deployments[0], rateCardId: "no-card" },
      ...registry.deployments.slice(1),
    ]
    const pointers = compileIssues(input({ policy, registry })).map((i) => i.pointer)
    expect(pointers).toEqual(
      expect.arrayContaining([
        "/policy/actions/0/roles/solver",
        "/policy/actions/0/roles/lead",
        "/policy/actions/0/verifier_profile",
        "/policy/actions/5/verifier_profile",
        "/registry/aliases/fast/0",
        "/registry/deployments/0/rateCardId",
      ])
    )
  })

  it("validates limits and extension coverage", () => {
    const extensions = builtinExtensions()
    extensions.panel_review = {
      ...extensions.panel_review,
      limits: { ...extensions.panel_review.limits, panel_min_candidates: 3, deadline_ms: 10 },
    }
    delete (extensions as Record<string, unknown>).cascade_code
    extensions.ghost = defaultExtension("direct")
    const pointers = compileIssues(input({ extensions })).map((i) => i.pointer)
    expect(pointers).toEqual(
      expect.arrayContaining([
        "/extensions/panel_review/limits/panel_min_candidates",
        "/extensions/panel_review/limits/deadline_ms",
        "/extensions/cascade_code",
        "/extensions/ghost",
      ])
    )
  })

  it("rejects duplicate actions, deployments and rate cards", () => {
    const policy = builtinPolicy()
    policy.actions.push({ ...policy.actions[0] })
    const registry = fakeTierRegistry()
    registry.deployments.push({ ...registry.deployments[0] })
    registry.rate_cards.push({ ...registry.rate_cards[0] })
    const messages = compileIssues(input({ policy, registry })).map((i) => i.message)
    expect(messages).toEqual(
      expect.arrayContaining([
        "duplicate action direct_baseline",
        "duplicate deployment id fake-economy",
        "duplicate rate card fake-rate-economy",
      ])
    )
  })

  it("[ACC:ROUTE-05] changes the action hash when a model revision, prompt or limit changes", () => {
    const base = compileFusionConfig(input()).actions.direct_baseline.actionHash

    const registry = fakeTierRegistry()
    registry.deployments = registry.deployments.map((d) =>
      d.id === "fake-baseline" ? { ...d, modelRevision: "mock/baseline-v2" } : d
    )
    expect(compileFusionConfig(input({ registry })).actions.direct_baseline.actionHash).not.toBe(
      base
    )

    const policy = builtinPolicy()
    policy.actions[0] = { ...policy.actions[0], prompt_version: "roles-2" }
    expect(compileFusionConfig(input({ policy })).actions.direct_baseline.actionHash).not.toBe(base)

    const extensions = builtinExtensions()
    extensions.direct_baseline = { ...extensions.direct_baseline, run_cap_microusd: 1 }
    expect(compileFusionConfig(input({ extensions })).actions.direct_baseline.actionHash).not.toBe(
      base
    )

    // Unrelated actions keep their hash.
    expect(compileFusionConfig(input({ extensions })).actions.direct_economy.actionHash).toBe(
      compileFusionConfig(input()).actions.direct_economy.actionHash
    )
  })

  it("names every field a deployment got wrong, one pointer each", () => {
    const registry = fakeTierRegistry()
    registry.deployments = [
      {
        ...registry.deployments[0],
        id: "",
        contextLimit: 0,
        maxOutputTokens: 0,
        dataClasses: [],
        p95LatencyMs: -1,
      },
      ...registry.deployments.slice(1),
    ]
    const issues = compileIssues(input({ registry }))
    expect(issues.map((i) => i.pointer)).toEqual(
      expect.arrayContaining([
        "/registry/deployments/0/id",
        "/registry/deployments/0/contextLimit",
        "/registry/deployments/0/maxOutputTokens",
        "/registry/deployments/0/dataClasses",
        "/registry/deployments/0/p95LatencyMs",
      ])
    )
    expect(issues.find((i) => i.pointer === "/registry/deployments/0/dataClasses")?.message).toBe(
      "a deployment must declare at least one data class"
    )
  })

  it("holds every limit to its own shape, ceiling and V1 cap", () => {
    const extensions = builtinExtensions()
    extensions.direct_baseline = {
      ...extensions.direct_baseline,
      limits: {
        ...extensions.direct_baseline.limits,
        max_model_calls: 0,
        max_format_repairs: -1,
        deadline_ms: 7_200_000,
      },
      run_cap_microusd: -1,
      role_output_tokens: 0,
    }
    extensions.panel_review = {
      ...extensions.panel_review,
      limits: {
        ...extensions.panel_review.limits,
        panel_size: 4,
        panel_evidence_rounds: 2,
      },
    }
    const pointers = compileIssues(input({ extensions })).map((i) => i.pointer)
    expect(pointers).toEqual(
      expect.arrayContaining([
        "/extensions/direct_baseline/limits/max_model_calls",
        "/extensions/direct_baseline/limits/max_format_repairs",
        "/extensions/direct_baseline/limits/deadline_ms",
        "/extensions/direct_baseline/run_cap_microusd",
        "/extensions/direct_baseline/role_output_tokens",
        "/extensions/panel_review/limits/panel_size",
        "/extensions/panel_review/limits/panel_evidence_rounds",
      ])
    )
  })

  it("requires the third panel seat once panel_size is 3", () => {
    const policy = builtinPolicy()
    const panel = policy.actions.findIndex((a) => a.mode === "panel")
    const { panel_c: _dropped, ...roles } = policy.actions[panel].roles as Record<string, string>
    policy.actions[panel] = { ...policy.actions[panel], roles } as never
    const extensions = builtinExtensions()
    const id = policy.actions[panel].id
    extensions[id] = {
      ...extensions[id],
      limits: { ...extensions[id].limits, panel_size: 3 },
    }
    expect(compileIssues(input({ policy, extensions }))).toContainEqual({
      pointer: `/policy/actions/${panel}/roles/panel_c`,
      message: "panel_size 3 requires a panel_c role",
    })
  })

  it("points at the action itself when it is not an action at all", () => {
    const policy = builtinPolicy()
    policy.actions[0] = "not an action" as never
    expect(compileIssues(input({ policy })).map((i) => i.pointer)).toContain("/policy/actions/0")
  })

  it("surfaces zod issues for a malformed policy", () => {
    const policy = { ...builtinPolicy(), switch_margin: 2 } as PolicyConfig
    expect(compileIssues(input({ policy })).map((i) => i.pointer)).toContain(
      "/policy/switch_margin"
    )
  })
})

describe("spec example mirrors", () => {
  it("mirrors models.mock.yaml exactly", () => {
    const yaml = parse(readFileSync(join(SPEC_DIR, "models.mock.yaml"), "utf8"))
    expect(SPEC_MOCK_REGISTRY.registry_version).toBe(yaml.registry_version)
    expect(SPEC_MOCK_REGISTRY.rate_cards).toEqual(yaml.rate_cards)
    expect(
      Object.fromEntries(Object.entries(SPEC_MOCK_REGISTRY.aliases).map(([k, v]) => [k, v[0]]))
    ).toEqual(yaml.aliases)
    for (const deployment of yaml.deployments) {
      const mirror = SPEC_MOCK_REGISTRY.deployments.find((d) => d.id === deployment.id)
      expect(mirror).toMatchObject({
        modelRevision: deployment.model_revision,
        dataClasses: deployment.data_classes,
        contextLimit: deployment.context_limit,
        maxOutputTokens: deployment.max_output_tokens,
        supportsTools: deployment.supports_tools,
        supportsJsonSchema: deployment.supports_json_schema,
        usageLookup: deployment.usage_lookup,
        providerIdempotency: deployment.provider_idempotency,
        cacheMode: deployment.cache_mode,
        rateCardId: deployment.rate_card_id,
        enabled: deployment.enabled,
      })
    }
  })

  it("compiles the spec's policy.example.yaml against its mock registry", () => {
    const policy = parse(
      readFileSync(join(SPEC_DIR, "policy.example.yaml"), "utf8")
    ) as PolicyConfig
    expect(PolicyConfigSchema.safeParse(policy).success).toBe(true)
    const extensions = Object.fromEntries(
      policy.actions.map((a) => [a.id, defaultExtension(a.mode)])
    )
    expect(() =>
      compileFusionConfig({ policy, registry: SPEC_MOCK_REGISTRY, extensions, environment: "test" })
    ).not.toThrow()
    expect(() =>
      compileFusionConfig({
        policy,
        registry: SPEC_MOCK_REGISTRY,
        extensions,
        environment: "production",
      })
    ).toThrow(ConfigCompileError)
  })
})
