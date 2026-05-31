/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

import { MobileQuickActions } from "./mobile-quick-actions"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { MobileHomeLayout } from "@/types/shell/mobile-home"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}))

jest.mock("@/lib/capacitor/haptics", () => ({
  selectionFeedback: jest.fn(async () => {}),
}))

const saveMock = jest.fn(async () => {})

function setLayout(layout: MobileHomeLayout) {
  useSettingsStore.setState({
    settings: { mobileHomeLayout: layout } as never,
    save: saveMock as never,
  })
}

beforeEach(() => {
  push.mockReset()
  saveMock.mockClear()
  setLayout({ quickActions: ["newChat", "search", "workflows"], hiddenSections: [] })
})

describe("MobileQuickActions", () => {
  it("renders a tile per active action", () => {
    render(<MobileQuickActions onNewChat={jest.fn()} onSearch={jest.fn()} />)
    expect(screen.getByTestId("mobile-quick-action-newChat")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-quick-action-search")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-quick-action-workflows")).toBeInTheDocument()
  })

  it("returns null when the section is hidden", () => {
    setLayout({ quickActions: ["newChat"], hiddenSections: ["quickActions"] })
    const { container } = render(<MobileQuickActions onNewChat={jest.fn()} onSearch={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("returns null when there are no active actions", () => {
    setLayout({ quickActions: [], hiddenSections: [] })
    const { container } = render(<MobileQuickActions onNewChat={jest.fn()} onSearch={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("dispatches newChat / search / route taps", () => {
    const onNewChat = jest.fn()
    const onSearch = jest.fn()
    render(<MobileQuickActions onNewChat={onNewChat} onSearch={onSearch} />)

    fireEvent.click(screen.getByTestId("mobile-quick-action-newChat"))
    expect(onNewChat).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("mobile-quick-action-search"))
    expect(onSearch).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("mobile-quick-action-workflows"))
    expect(push).toHaveBeenCalledWith("/workflows")
  })

  it("activates a tile via keyboard", () => {
    const onNewChat = jest.fn()
    render(<MobileQuickActions onNewChat={onNewChat} onSearch={jest.fn()} />)
    fireEvent.keyDown(screen.getByTestId("mobile-quick-action-newChat"), { key: "Enter" })
    expect(onNewChat).toHaveBeenCalled()
  })

  it("opens the customizer sheet on Edit", () => {
    render(<MobileQuickActions onNewChat={jest.fn()} onSearch={jest.fn()} />)
    fireEvent.click(screen.getByTestId("mobile-quick-actions-edit"))
    expect(screen.getByTestId("mobile-quick-actions-editor")).toBeInTheDocument()
  })
})
