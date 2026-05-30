import { render } from "@testing-library/react"

const refreshMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/ai/providers/models-dev-sync", () => ({
  refreshModelsDevCatalogIfStale: (...a: unknown[]) => refreshMock(...a),
}))

import { ModelsDevCatalogInitializer } from "./models-dev-catalog-initializer"

beforeEach(() => refreshMock.mockClear())

describe("ModelsDevCatalogInitializer", () => {
  it("kicks off a stale-refresh once on mount and renders nothing", () => {
    const { container, rerender } = render(<ModelsDevCatalogInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(refreshMock).toHaveBeenCalledTimes(1)
    // Re-render must not fire a second refresh (guarded by the ref).
    rerender(<ModelsDevCatalogInitializer />)
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })
})
