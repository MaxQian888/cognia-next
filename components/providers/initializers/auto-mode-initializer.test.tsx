import { render } from "@testing-library/react"
import { AutoModeInitializer } from "./auto-mode-initializer"

const mockUseAutoMode = jest.fn()
jest.mock("@/lib/appearance/use-auto-mode", () => ({
  useAutoMode: () => mockUseAutoMode(),
}))

describe("AutoModeInitializer", () => {
  beforeEach(() => mockUseAutoMode.mockClear())

  it("runs the auto-mode hook and renders nothing", () => {
    const { container } = render(<AutoModeInitializer />)
    expect(mockUseAutoMode).toHaveBeenCalledTimes(1)
    expect(container).toBeEmptyDOMElement()
  })
})
