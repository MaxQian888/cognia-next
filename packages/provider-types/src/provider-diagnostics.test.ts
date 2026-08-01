import {
  clampProviderDiagnosticsBudget,
  DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES,
  PROVIDER_DIAGNOSTICS_HARD_LIMITS,
  type ProviderDiagnosticsPreferences,
} from "./provider-diagnostics"

function preferences(
  overrides: Partial<ProviderDiagnosticsPreferences> = {}
): ProviderDiagnosticsPreferences {
  return { ...DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES, ...overrides }
}

describe("clampProviderDiagnosticsBudget", () => {
  it("caps both budget fields at the ADR-0104 hard limits", () => {
    const clamped = clampProviderDiagnosticsBudget(
      preferences({ maxRequestsPerJob: 5_000, maxEstimatedCostUsd: 100 })
    )

    expect(clamped.maxRequestsPerJob).toBe(PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxRequestsPerJob)
    expect(clamped.maxEstimatedCostUsd).toBe(PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxEstimatedCostUsd)
  })

  it("lets a caller ask for less", () => {
    const clamped = clampProviderDiagnosticsBudget(
      preferences({ maxRequestsPerJob: 3, maxEstimatedCostUsd: 0.01 })
    )

    expect(clamped.maxRequestsPerJob).toBe(3)
    expect(clamped.maxEstimatedCostUsd).toBe(0.01)
  })

  it("reads a broken value as the ceiling rather than as unlimited", () => {
    // A hand-edited or half-migrated settings row, not a deliberate choice.
    const clamped = clampProviderDiagnosticsBudget(
      preferences({
        maxRequestsPerJob: Number.POSITIVE_INFINITY,
        maxEstimatedCostUsd: Number.NaN,
      })
    )

    expect(clamped.maxRequestsPerJob).toBe(PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxRequestsPerJob)
    expect(clamped.maxEstimatedCostUsd).toBe(PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxEstimatedCostUsd)
  })

  it("reads a negative value as the ceiling, not as a permanent block", () => {
    const clamped = clampProviderDiagnosticsBudget(
      preferences({ maxRequestsPerJob: -1, maxEstimatedCostUsd: -5 })
    )

    expect(clamped.maxRequestsPerJob).toBe(PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxRequestsPerJob)
    expect(clamped.maxEstimatedCostUsd).toBe(PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxEstimatedCostUsd)
  })

  it("leaves every non-budget preference untouched", () => {
    const input = preferences({ concurrency: 7, maxRequestsPerJob: 9_000 })
    const clamped = clampProviderDiagnosticsBudget(input)

    expect(clamped.concurrency).toBe(7)
    expect(clamped.probeTimeoutMs).toBe(input.probeTimeoutMs)
    expect(clamped.remotePaidDiagnosticsEnabled).toBe(input.remotePaidDiagnosticsEnabled)
  })

  it("ships defaults that are already at the ceiling", () => {
    expect(clampProviderDiagnosticsBudget(preferences())).toEqual(
      DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES
    )
  })
})
