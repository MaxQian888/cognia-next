/**
 * Deterministic routing fixtures for tests and the offline Fake Provider
 * end-to-end path. Everything is `example_only` and refused in production.
 */

import { CONTRACT_SCHEMA_VERSION, type RoutingFeatures } from "../contracts/schemas"
import { builtinExtensions, builtinPolicy } from "../config/builtin-catalog"
import { compileFusionConfig } from "../config/compile"
import type { CompiledFusionConfig, FusionConfigInput, VerifierProfile } from "../config/types"
import type { RouteRequest } from "../routing/action-router"
import { fakeTierRegistry } from "./mock-registry"

export const ALL_VERIFIER_PROFILES: VerifierProfile[] = [
  "text_basic",
  "text_review",
  "schema_fixture",
  "evidence_review",
  "code_fixture",
]

export function fakeCompiledConfig(
  overrides: Partial<FusionConfigInput> = {}
): CompiledFusionConfig {
  return compileFusionConfig({
    policy: builtinPolicy(),
    registry: fakeTierRegistry(),
    extensions: builtinExtensions(),
    environment: "test",
    ...overrides,
  })
}

export function fixtureFeatures(overrides: Partial<RoutingFeatures> = {}): RoutingFeatures {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    goal: "fixture goal",
    task: "qa.knowledge",
    phase: "intake",
    language: "en",
    missing_information: [],
    ambiguity: "low",
    tool_need: "none",
    scope: "single_item",
    failed_attempts: 0,
    verification_kinds: [],
    source_revision: null,
    feature_version: "features-1",
    context_truncated: false,
    ...overrides,
  }
}

export function fixtureRouteRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    decisionId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-09-15T08:00:00Z",
    requestedMode: "auto",
    allowedModes: ["direct", "cascade", "panel", "delegate"],
    profile: "balanced",
    deliversChange: false,
    budgetMode: "tracked",
    runAvailableMicrousd: 5_000_000,
    deadlineRemainingMs: 3_600_000,
    dataPolicy: {
      dataClass: "internal",
      restrictedGrantProviderIds: [],
      revokedDeploymentIds: [],
    },
    inputModalities: ["text"],
    estimatedInputTokens: 1000,
    features: fixtureFeatures(),
    classifierVersion: "rules-1",
    approvedRuleRows: [],
    health: {},
    capabilities: {
      sandboxTier: "os",
      acceptanceProfileAvailable: true,
      verifierProfiles: ALL_VERIFIER_PROFILES,
      webToolsAvailable: true,
    },
    hasFusionAncestor: false,
    unknownPriceCallReserveMicrousd: 50_000,
    ...overrides,
  }
}
