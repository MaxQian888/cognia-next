import { render } from "@testing-library/react"

const setAdaptersMock = jest.fn()
const builtAdapters = { marker: "provider-core-deps" }
jest.mock("@cognia/provider-core/providers/runtime-adapters", () => ({
  setProviderCoreRuntimeAdapters: (...a: unknown[]) => setAdaptersMock(...a),
}))
jest.mock("@/lib/ai/provider-core-runtime-deps", () => ({
  buildProviderCoreRuntimeAdapters: () => builtAdapters,
}))

import { ProviderCoreRuntimeInitializer } from "./provider-core-runtime-initializer"

beforeEach(() => {
  setAdaptersMock.mockClear()
})

describe("ProviderCoreRuntimeInitializer", () => {
  it("installs the host-backed adapters once and renders nothing", () => {
    const { container } = render(<ProviderCoreRuntimeInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
    expect(setAdaptersMock).toHaveBeenCalledWith(builtAdapters)
  })

  it("does not re-install on re-render (ref guard)", () => {
    const { rerender } = render(<ProviderCoreRuntimeInitializer />)
    rerender(<ProviderCoreRuntimeInitializer />)
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
  })
})
