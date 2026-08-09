/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { renderHook } from "@testing-library/react"

import {
  __resetPluginActivationProgressStoreForTesting,
  advancePluginActivationProgress,
  beginPluginActivationProgress,
  completePluginActivationProgress,
  failPluginActivationProgress,
} from "@/stores/plugin-runtime/plugin-activation-progress-store"

import { usePluginActivationProgress } from "./use-plugin-activation-progress"

beforeEach(() => {
  __resetPluginActivationProgressStoreForTesting()
})

afterEach(() => {
  __resetPluginActivationProgressStoreForTesting()
})

describe("no activation in flight", () => {
  it("reports an inert view rather than throwing", () => {
    const { result } = renderHook(() => usePluginActivationProgress("ghost"))
    expect(result.current).toEqual({
      progress: null,
      active: false,
      terminal: false,
      percent: 0,
      phaseLabel: "",
      countLabel: "",
    })
  })
})

describe("running activation", () => {
  it("reports percent and localized labels for the current phase", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "runtime")

    const { result } = renderHook(() => usePluginActivationProgress("p"))
    expect(result.current.active).toBe(true)
    expect(result.current.terminal).toBe(false)
    // 3 of 7 → 43%.
    expect(result.current.percent).toBe(43)
    expect(result.current.phaseLabel).toBe("phase.runtime")
    expect(result.current.countLabel).toBe('countLabel:{"processed":3,"total":7}')
  })

  it("reports 0% at preflight and 100% once complete", () => {
    beginPluginActivationProgress("p")
    const start = renderHook(() => usePluginActivationProgress("p"))
    expect(start.result.current.percent).toBe(0)

    completePluginActivationProgress("p")
    const done = renderHook(() => usePluginActivationProgress("p"))
    expect(done.result.current.percent).toBe(100)
    expect(done.result.current.active).toBe(false)
    expect(done.result.current.terminal).toBe(true)
  })

  it("localizes every phase label", () => {
    for (const phase of [
      "preflight",
      "dependencies",
      "schema",
      "runtime",
      "contributions",
      "hooks",
      "commit",
    ] as const) {
      __resetPluginActivationProgressStoreForTesting()
      beginPluginActivationProgress("p")
      advancePluginActivationProgress("p", phase)
      const { result } = renderHook(() => usePluginActivationProgress("p"))
      expect(result.current.phaseLabel).toBe(`phase.${phase}`)
    }
  })
})

describe("terminal states", () => {
  it("reports a failure as terminal at the phase where it stopped", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "contributions")
    failPluginActivationProgress("p", new Error("boom"))

    const { result } = renderHook(() => usePluginActivationProgress("p"))
    expect(result.current.active).toBe(false)
    expect(result.current.terminal).toBe(true)
    expect(result.current.phaseLabel).toBe("phase.contributions")
  })
})

describe("scoping", () => {
  it("reads only the requested plugin's entry", () => {
    beginPluginActivationProgress("a")
    advancePluginActivationProgress("a", "commit")
    beginPluginActivationProgress("b")

    const { result } = renderHook(() => usePluginActivationProgress("b"))
    expect(result.current.percent).toBe(0)
  })
})
