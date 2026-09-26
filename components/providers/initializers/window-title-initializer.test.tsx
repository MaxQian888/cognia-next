import { render, screen } from "@testing-library/react"
import { WindowTitleInitializer } from "./window-title-initializer"

const useWindowTitleMock = jest.fn()
jest.mock("@/hooks/desktop/use-window-title", () => ({
  useWindowTitle: (count?: number) => useWindowTitleMock(count),
}))

const useAppBadgeMock = jest.fn()
jest.mock("@/hooks/desktop/use-app-badge", () => ({
  useAppAttentionCount: () => 4,
  useAppBadge: (count: number) => useAppBadgeMock(count),
}))

jest.mock("@/components/shell/nav-badge-probes", () => ({
  NavBadgeProbes: () => <span data-testid="nav-badge-probes" hidden />,
}))

const isMainMock = jest.fn(() => true)
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: () => isMainMock() }))

beforeEach(() => {
  useWindowTitleMock.mockClear()
  useAppBadgeMock.mockClear()
  isMainMock.mockReturnValue(true)
})

describe("WindowTitleInitializer", () => {
  it("in the main window, owns the attention count: probes, OS badge and tab title", () => {
    render(<WindowTitleInitializer />)
    expect(screen.getByTestId("nav-badge-probes")).toBeInTheDocument()
    expect(useAppBadgeMock).toHaveBeenCalledWith(4)
    expect(useWindowTitleMock).toHaveBeenCalledWith(4)
  })

  it("in an auxiliary window, keeps only a plain title and renders nothing", () => {
    isMainMock.mockReturnValue(false)
    const { container } = render(<WindowTitleInitializer />)
    expect(useWindowTitleMock).toHaveBeenCalledTimes(1)
    expect(useWindowTitleMock).toHaveBeenCalledWith(undefined)
    expect(useAppBadgeMock).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })
})
