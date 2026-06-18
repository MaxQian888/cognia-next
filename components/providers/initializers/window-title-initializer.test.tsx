import { render } from "@testing-library/react"
import { WindowTitleInitializer } from "./window-title-initializer"

const useWindowTitleMock = jest.fn()
jest.mock("@/hooks/desktop/use-window-title", () => ({
  useWindowTitle: () => useWindowTitleMock(),
}))

beforeEach(() => useWindowTitleMock.mockClear())

describe("WindowTitleInitializer", () => {
  it("runs the window-title hook and renders nothing", () => {
    const { container } = render(<WindowTitleInitializer />)
    expect(useWindowTitleMock).toHaveBeenCalledTimes(1)
    expect(container).toBeEmptyDOMElement()
  })
})
