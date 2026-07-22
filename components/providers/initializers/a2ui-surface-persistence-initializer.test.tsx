import { render } from "@testing-library/react"

const mockHydrate = jest.fn().mockResolvedValue(true)

jest.mock("@/stores/a2ui/a2ui-store", () => ({
  hydrateA2UISurfaceCache: () => mockHydrate(),
}))

import { A2UISurfacePersistenceInitializer } from "./a2ui-surface-persistence-initializer"

describe("A2UISurfacePersistenceInitializer", () => {
  beforeEach(() => mockHydrate.mockClear())

  it("hydrates the durable surface cache once", () => {
    const { container, rerender } = render(<A2UISurfacePersistenceInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(mockHydrate).toHaveBeenCalledTimes(1)

    rerender(<A2UISurfacePersistenceInitializer />)
    expect(mockHydrate).toHaveBeenCalledTimes(1)
  })
})
