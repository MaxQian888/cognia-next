import { render } from "@testing-library/react"

const setAdaptersMock = jest.fn()
const builtAdapters = { marker: "routing-deps" }
jest.mock("@cognia/provider-routing/runtime-adapters", () => ({
  setProviderRoutingRuntimeAdapters: (...a: unknown[]) => setAdaptersMock(...a),
}))
jest.mock("@/lib/claude/routing-runtime-deps", () => ({
  buildRoutingRuntimeAdapters: () => builtAdapters,
}))

import { RoutingRuntimeInitializer } from "./routing-runtime-initializer"

beforeEach(() => {
  setAdaptersMock.mockClear()
})

describe("RoutingRuntimeInitializer", () => {
  it("installs the store-backed adapters once and renders nothing", () => {
    const { container } = render(<RoutingRuntimeInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
    expect(setAdaptersMock).toHaveBeenCalledWith(builtAdapters)
  })

  it("does not re-install on re-render (ref guard)", () => {
    const { rerender } = render(<RoutingRuntimeInitializer />)
    rerender(<RoutingRuntimeInitializer />)
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
  })
})
