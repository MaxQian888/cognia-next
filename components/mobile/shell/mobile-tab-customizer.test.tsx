/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"

import { MobileTabCustomizer, MobileTabCustomizerBody } from "./mobile-tab-customizer"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_MOBILE_TAB_LAYOUT, type MobileTabLayout } from "@/types/shell/mobile-tabs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async (_patch?: { mobileTabLayout?: MobileTabLayout }) => {})

function setLayout(layout?: MobileTabLayout) {
  useSettingsStore.setState({
    settings: (layout ? { mobileTabLayout: layout } : {}) as never,
    save: saveMock as never,
  })
}

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.mobileTabLayout as MobileTabLayout

beforeEach(() => {
  saveMock.mockClear()
  setLayout(undefined)
})

describe("MobileTabCustomizerBody", () => {
  it("renders a row per tab", () => {
    render(<MobileTabCustomizerBody />)
    for (const id of ["chat", "workflows", "discover", "me"]) {
      expect(screen.getByTestId(`mobile-tab-customizer-row-${id}`)).toBeInTheDocument()
    }
  })

  it("hides a tab via its toggle", () => {
    render(<MobileTabCustomizerBody />)
    fireEvent.click(screen.getByTestId("mobile-tab-customizer-toggle-discover"))
    expect(lastSaved().hidden).toEqual(["discover"])
  })

  it("shows a hidden tab via its toggle", () => {
    setLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["discover"],
      defaultLanding: "chat",
    })
    render(<MobileTabCustomizerBody />)
    fireEvent.click(screen.getByTestId("mobile-tab-customizer-toggle-discover"))
    expect(lastSaved().hidden).toEqual([])
  })

  it("disables the toggle for visible tabs at the floor", () => {
    setLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["discover", "me"],
      defaultLanding: "chat",
    })
    render(<MobileTabCustomizerBody />)
    // Only chat + workflows visible → their toggles are disabled.
    expect(screen.getByTestId("mobile-tab-customizer-toggle-chat")).toBeDisabled()
    // Hidden tabs can still be shown.
    expect(screen.getByTestId("mobile-tab-customizer-toggle-discover")).not.toBeDisabled()
  })

  it("selects a launch landing tab", () => {
    render(<MobileTabCustomizerBody />)
    fireEvent.click(screen.getByTestId("mobile-tab-customizer-landing-workflows"))
    expect(lastSaved().defaultLanding).toBe("workflows")
  })

  it("only offers visible tabs as landing choices", () => {
    setLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["discover"],
      defaultLanding: "chat",
    })
    render(<MobileTabCustomizerBody />)
    expect(screen.queryByTestId("mobile-tab-customizer-landing-discover")).not.toBeInTheDocument()
    expect(screen.getByTestId("mobile-tab-customizer-landing-workflows")).toBeInTheDocument()
  })

  it("reset is disabled at the default layout and enabled otherwise", () => {
    setLayout(DEFAULT_MOBILE_TAB_LAYOUT)
    const { rerender } = render(<MobileTabCustomizerBody />)
    expect(screen.getByTestId("mobile-tab-customizer-reset")).toBeDisabled()

    act(() => setLayout({ order: ["me", "chat"], hidden: [], defaultLanding: "chat" }))
    rerender(<MobileTabCustomizerBody />)
    expect(screen.getByTestId("mobile-tab-customizer-reset")).not.toBeDisabled()
  })

  it("restores defaults on click", () => {
    setLayout({ order: ["me", "chat"], hidden: ["discover"], defaultLanding: "me" })
    render(<MobileTabCustomizerBody />)
    fireEvent.click(screen.getByTestId("mobile-tab-customizer-reset"))
    expect(lastSaved()).toEqual(DEFAULT_MOBILE_TAB_LAYOUT)
  })

  it("starts a keyboard drag without throwing", () => {
    render(<MobileTabCustomizerBody />)
    const handle = screen.getByTestId("mobile-tab-customizer-handle-chat")
    act(() => {
      fireEvent.keyDown(handle, { code: "Space" })
      fireEvent.keyDown(handle, { code: "ArrowDown" })
      fireEvent.keyDown(handle, { code: "Space" })
    })
    expect(screen.getByTestId("mobile-tab-customizer-row-chat")).toBeInTheDocument()
  })
})

describe("MobileTabCustomizer", () => {
  it("opens the sheet from the row", () => {
    render(<MobileTabCustomizer />)
    expect(screen.queryByTestId("mobile-tab-customizer")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mobile-tab-customizer-row"))
    expect(screen.getByTestId("mobile-tab-customizer")).toBeInTheDocument()
  })

  it("closes the sheet on Android hardware back (popstate)", () => {
    render(<MobileTabCustomizer />)
    fireEvent.click(screen.getByTestId("mobile-tab-customizer-row"))
    expect(screen.getByTestId("mobile-tab-customizer-sheet")).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(screen.queryByTestId("mobile-tab-customizer-sheet")).not.toBeInTheDocument()
  })
})
