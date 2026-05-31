/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"

import { MobileQuickActionsEditor } from "./mobile-quick-actions-editor"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_MOBILE_HOME_LAYOUT, type MobileHomeLayout } from "@/types/shell/mobile-home"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async (_patch?: { mobileHomeLayout?: MobileHomeLayout }) => {})

function setLayout(layout: MobileHomeLayout) {
  useSettingsStore.setState({
    settings: { mobileHomeLayout: layout } as never,
    save: saveMock as never,
  })
}

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.mobileHomeLayout as MobileHomeLayout

beforeEach(() => {
  saveMock.mockClear()
  setLayout({ quickActions: ["newChat", "search"], hiddenSections: [] })
})

describe("MobileQuickActionsEditor", () => {
  it("renders active rows and available rows", () => {
    render(<MobileQuickActionsEditor />)
    expect(screen.getByTestId("mobile-home-editor-active-newChat")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-home-editor-active-search")).toBeInTheDocument()
    // 'workflows' is not active → available pool.
    expect(screen.getByTestId("mobile-home-editor-row-workflows")).toBeInTheDocument()
  })

  it("removes an active action", () => {
    render(<MobileQuickActionsEditor />)
    fireEvent.click(screen.getByTestId("mobile-home-editor-remove-search"))
    expect(lastSaved().quickActions).toEqual(["newChat"])
  })

  it("adds an available action", () => {
    render(<MobileQuickActionsEditor />)
    fireEvent.click(screen.getByTestId("mobile-home-editor-add-workflows"))
    expect(lastSaved().quickActions).toEqual(["newChat", "search", "workflows"])
  })

  it("toggles a section off and on", () => {
    render(<MobileQuickActionsEditor />)
    fireEvent.click(screen.getByTestId("mobile-home-editor-section-toggle-recents"))
    expect(lastSaved().hiddenSections).toEqual(["recents"])

    act(() => setLayout({ quickActions: ["newChat"], hiddenSections: ["recents"] }))
    fireEvent.click(screen.getByTestId("mobile-home-editor-section-toggle-recents"))
    expect(lastSaved().hiddenSections).toEqual([])
  })

  it("reset is disabled at the default layout and enabled otherwise", () => {
    setLayout(DEFAULT_MOBILE_HOME_LAYOUT)
    const { rerender } = render(<MobileQuickActionsEditor />)
    expect(screen.getByTestId("mobile-home-editor-reset")).toBeDisabled()

    act(() => setLayout({ quickActions: ["newChat"], hiddenSections: [] }))
    rerender(<MobileQuickActionsEditor />)
    expect(screen.getByTestId("mobile-home-editor-reset")).not.toBeDisabled()
  })

  it("restores defaults on click", () => {
    setLayout({ quickActions: ["search"], hiddenSections: ["recents"] })
    render(<MobileQuickActionsEditor />)
    fireEvent.click(screen.getByTestId("mobile-home-editor-reset"))
    expect(lastSaved()).toEqual(DEFAULT_MOBILE_HOME_LAYOUT)
  })

  it("shows the active-empty placeholder when no actions are pinned", () => {
    setLayout({ quickActions: [], hiddenSections: [] })
    render(<MobileQuickActionsEditor />)
    expect(screen.getByText("activeEmpty")).toBeInTheDocument()
  })

  it("starts a keyboard drag from the grip without throwing", () => {
    render(<MobileQuickActionsEditor />)
    const handle = screen.getByTestId("mobile-home-editor-handle-newChat")
    act(() => {
      fireEvent.keyDown(handle, { code: "Space" })
      fireEvent.keyDown(handle, { code: "ArrowDown" })
      fireEvent.keyDown(handle, { code: "Space" })
    })
    expect(screen.getByTestId("mobile-home-editor-active-newChat")).toBeInTheDocument()
  })
})
