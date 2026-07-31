import { render } from "@testing-library/react"

const initializeMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/ai/providers/models-dev-sync", () => ({
  initializeProviderCatalog: (...a: unknown[]) => initializeMock(...a),
}))

import { ModelsDevCatalogInitializer } from "./models-dev-catalog-initializer"

beforeEach(() => initializeMock.mockClear())

describe("ModelsDevCatalogInitializer", () => {
  it("kicks off a stale-refresh once on mount and renders nothing", () => {
    const { container, rerender } = render(<ModelsDevCatalogInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(initializeMock).toHaveBeenCalledTimes(1)
    // Re-render must not fire a second refresh (guarded by the ref).
    rerender(<ModelsDevCatalogInitializer />)
    expect(initializeMock).toHaveBeenCalledTimes(1)
  })
})
