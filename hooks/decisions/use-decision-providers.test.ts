/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { createDecisionRegistry } from "@/lib/decisions/registry"
import type { DecisionProvider } from "@/types/decisions"

jest.mock("@/lib/decisions/host-registry", () => ({ getDecisionRegistry: jest.fn() }))

import { useDecisionProvider, useDecisionProviders } from "./use-decision-providers"

function provider(id: string): DecisionProvider {
  return {
    id,
    label: id,
    locality: "local",
    calibrated: true,
    decide: async () => ({ ok: true, answers: {} }),
  }
}

describe("useDecisionProviders", () => {
  it("tracks registrations and removals", () => {
    const registry = createDecisionRegistry()
    const { result } = renderHook(() => useDecisionProviders(() => registry))
    expect(result.current).toEqual([])
    act(() => registry.register(provider("p:a")))
    expect(result.current.map((p) => p.id)).toEqual(["p:a"])
    act(() => {
      registry.unregister("p:a")
    })
    expect(result.current).toEqual([])
  })

  it("keeps the same array between unrelated renders", () => {
    const registry = createDecisionRegistry()
    registry.register(provider("p:a"))
    const { result, rerender } = renderHook(() => useDecisionProviders(() => registry))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

describe("useDecisionProvider", () => {
  it("resolves one provider by id and follows its lifecycle", () => {
    const registry = createDecisionRegistry()
    const { result } = renderHook(({ id }) => useDecisionProvider(id, () => registry), {
      initialProps: { id: "p:a" as string | undefined },
    })
    expect(result.current).toBeUndefined()
    act(() => registry.register(provider("p:a")))
    expect(result.current?.id).toBe("p:a")
  })

  it("returns undefined without an id", () => {
    const registry = createDecisionRegistry()
    registry.register(provider("p:a"))
    const { result } = renderHook(() => useDecisionProvider(undefined, () => registry))
    expect(result.current).toBeUndefined()
  })
})
