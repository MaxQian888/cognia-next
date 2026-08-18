import { render, waitFor } from "@testing-library/react"

const setAdaptersMock = jest.fn()
const builtAdapters = { marker: "routing-deps" }
const certificationStore = { marker: "certification-store" }
const installDesktopCertificationRuntimeMock = jest.fn(async () => certificationStore)
const rebuildCompatibilityProjectionMock = jest.fn<Promise<number>, [unknown]>(async () => 1)
const setPricingResolverMock = jest.fn()
const resolveModelPricingUsdMock = jest.fn(() => ({ promptPer1M: 3, completionPer1M: 15 }))
jest.mock("@cognia/provider-routing/runtime-adapters", () => ({
  setProviderRoutingRuntimeAdapters: (...a: unknown[]) => setAdaptersMock(...a),
}))
jest.mock("@cognia/provider-core/providers/model-pricing", () => ({
  setModelPricingResolver: (...a: unknown[]) => setPricingResolverMock(...a),
}))
jest.mock("@/lib/usage/pricing", () => ({
  resolveModelPricingUsd: (...a: unknown[]) => resolveModelPricingUsdMock(...a),
}))
jest.mock("@/lib/claude/routing-runtime-deps", () => ({
  buildRoutingRuntimeAdapters: () => builtAdapters,
}))
jest.mock("@/lib/ai/agent/execution/certification-store", () => ({
  installDesktopCertificationRuntime: () => installDesktopCertificationRuntimeMock(),
}))
jest.mock("@/lib/db/agent-compatibility", () => ({
  rebuildCompatibilityProjection: (store: unknown) => rebuildCompatibilityProjectionMock(store),
}))

import { RoutingRuntimeInitializer } from "./routing-runtime-initializer"

beforeEach(() => {
  setAdaptersMock.mockClear()
  setPricingResolverMock.mockClear()
  resolveModelPricingUsdMock.mockClear()
  installDesktopCertificationRuntimeMock.mockClear()
  rebuildCompatibilityProjectionMock.mockClear()
})

describe("RoutingRuntimeInitializer", () => {
  it("installs routing and hydrates the certification projection once", async () => {
    const { container } = render(<RoutingRuntimeInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
    expect(setAdaptersMock).toHaveBeenCalledWith(builtAdapters)
    await waitFor(() => expect(installDesktopCertificationRuntimeMock).toHaveBeenCalledTimes(1))
    expect(rebuildCompatibilityProjectionMock).toHaveBeenCalledWith(certificationStore)
  })

  it("does not re-install on re-render (ref guard)", async () => {
    const { rerender } = render(<RoutingRuntimeInitializer />)
    rerender(<RoutingRuntimeInitializer />)
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(installDesktopCertificationRuntimeMock).toHaveBeenCalledTimes(1))
  })
})

describe("pricing resolver installation", () => {
  it("installs the host pricing resolver into provider-core", () => {
    // Regression guard: `setModelPricingResolver` shipped as an injection seam
    // with no production caller, so the routing engine ran on provider-core's
    // own resolver — which omits the static MODEL_PRICING layer. Models known
    // only to the static tables therefore priced as `null` (unknown) for
    // cost-aware ranking and `dailyCostBudget`, while the Usage tab priced them
    // fine. If this assertion goes red, that divergence is back.
    render(<RoutingRuntimeInitializer />)
    expect(setPricingResolverMock).toHaveBeenCalledTimes(1)
  })

  it("delegates to the unified resolver, forwarding provider, model and options", () => {
    render(<RoutingRuntimeInitializer />)
    const installed = setPricingResolverMock.mock.calls[0]![0] as (
      providerId: string | undefined,
      modelId: string | undefined,
      opts?: unknown
    ) => unknown

    const opts = { settings: { providerSettings: {} } }
    const out = installed("anthropic", "claude-sonnet-4-6", opts)

    expect(resolveModelPricingUsdMock).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", opts)
    expect(out).toEqual({ promptPer1M: 3, completionPer1M: 15 })
  })

  it("installs the resolver only once across re-renders", () => {
    const { rerender } = render(<RoutingRuntimeInitializer />)
    rerender(<RoutingRuntimeInitializer />)
    rerender(<RoutingRuntimeInitializer />)
    expect(setPricingResolverMock).toHaveBeenCalledTimes(1)
  })
})
