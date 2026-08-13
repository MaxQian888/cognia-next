/** @jest-environment jsdom */

import { render } from "@testing-library/react"

const getCollector = jest.fn()
const setScope = jest.fn()

jest.mock("@/lib/perf/renderer-collector", () => ({
  getRendererPerformanceCollector: () => getCollector(),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => ({ accountId: "account-a", targetId: "target-a" }),
}))

import { RendererPerfInitializer } from "./renderer-perf-initializer"

describe("RendererPerfInitializer", () => {
  it("registers the authenticated full document without rendering UI or starting demand", () => {
    getCollector.mockReturnValue({ setScope })
    const { container } = render(<RendererPerfInitializer />)
    expect(container.firstChild).toBeNull()
    expect(getCollector).toHaveBeenCalledTimes(1)
    expect(setScope).toHaveBeenCalledWith({ targetId: "target-a", routingGeneration: 0 })
  })
})
