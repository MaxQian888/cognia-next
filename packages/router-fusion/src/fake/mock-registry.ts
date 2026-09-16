/**
 * The spec's example registry (`contracts/spec/models.mock.yaml`) as a
 * `FusionRegistry`, plus a mock registry keyed by the host's routing tiers so
 * the built-in catalog compiles against Fake Provider deployments.
 *
 * `example_only` is set everywhere: the compiler refuses all of this in
 * production (CFG-01). A test parses the vendored YAML and asserts these values
 * match it, so the mirror cannot drift.
 */

import type { FusionDeployment, FusionRegistry } from "../config/types"

function fakeDeployment(
  id: string,
  revision: string,
  rateCardId: string,
  p95LatencyMs: number
): FusionDeployment {
  return {
    id,
    providerId: "fake",
    modelRevision: revision,
    dataClasses: ["public", "internal", "restricted"],
    inputModalities: ["text", "image"],
    contextLimit: 65536,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsJsonSchema: true,
    usageLookup: true,
    providerIdempotency: true,
    cacheMode: "none",
    rateCardId,
    internalRetry: "none",
    billingTransparency: "bounded",
    enabled: true,
    exampleOnly: true,
    p95LatencyMs,
  }
}

export const SPEC_MOCK_REGISTRY: FusionRegistry = {
  registry_version: "mock-models-1",
  example_only: true,
  deployments: [
    fakeDeployment("fake-economy", "mock/economy-v1", "fake-rate-economy", 400),
    fakeDeployment("fake-baseline", "mock/baseline-v1", "fake-rate-baseline", 900),
    fakeDeployment("fake-independent", "mock/independent-v1", "fake-rate-independent", 700),
  ],
  aliases: {
    economy: ["fake-economy"],
    baseline: ["fake-baseline"],
    independent: ["fake-independent"],
  },
  rate_cards: [
    {
      id: "fake-rate-economy",
      example_only: true,
      currency: "USD",
      ordinary_input_per_million: "0.10",
      output_per_million: "0.20",
      cache_read_per_million: "0.00",
      cache_write_5m_per_million: "0.10",
      cache_write_1h_per_million: "0.10",
    },
    {
      id: "fake-rate-baseline",
      example_only: true,
      currency: "USD",
      ordinary_input_per_million: "1.00",
      output_per_million: "2.00",
      cache_read_per_million: "0.00",
      cache_write_5m_per_million: "1.00",
      cache_write_1h_per_million: "1.00",
    },
    {
      id: "fake-rate-independent",
      example_only: true,
      currency: "USD",
      ordinary_input_per_million: "0.30",
      output_per_million: "0.60",
      cache_read_per_million: "0.00",
      cache_write_5m_per_million: "0.30",
      cache_write_1h_per_million: "0.30",
    },
  ],
}

/** The spec mock registry re-keyed by Cognia's routing tiers for the built-in catalog. */
export function fakeTierRegistry(): FusionRegistry {
  return {
    ...structuredClone(SPEC_MOCK_REGISTRY),
    registry_version: "mock-tiers-1",
    aliases: {
      fast: ["fake-economy"],
      powerful: ["fake-baseline"],
      balanced: ["fake-independent"],
    },
  }
}
