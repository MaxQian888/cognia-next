/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import { PlanModeBanner } from "./plan-mode-banner"
import { ComposerSessionProvider } from "./composer/composer-session-context"
import { useChatStore } from "@/stores/chat"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const setMode = (
  mode: Parameters<ReturnType<typeof useChatStore.getState>["setPermissionMode"]>[0]
) => act(() => useChatStore.getState().setPermissionMode(mode))

describe("PlanModeBanner", () => {
  afterEach(() => {
    setMode(null)
  })

  it("renders nothing outside plan mode", () => {
    setMode(null)
    const { container } = render(<PlanModeBanner />)
    expect(container).toBeEmptyDOMElement()

    setMode("acceptEdits")
    expect(screen.queryByTestId("plan-mode-banner")).not.toBeInTheDocument()
  })

  it("shows the amber banner with the cycle hint in plan mode", () => {
    setMode("plan")
    render(<PlanModeBanner />)
    const banner = screen.getByTestId("plan-mode-banner")
    expect(banner).toHaveTextContent("banner")
    expect(banner).toHaveTextContent("hint")
    expect(banner.className).toContain("border-amber-500/40")
  })

  it("announces the mode of the pane it sits above, not the focused one", () => {
    // Rendered inside an unfocused split pane it announced plan mode for the
    // pane beside it, and hid it for its own.
    act(() => {
      useChatStore.getState().setActiveSession("ses_focused")
      useChatStore.getState().setPermissionMode("plan", "ses_focused")
      useChatStore.getState().setPermissionMode("default", "ses_background")
    })

    render(
      <ComposerSessionProvider value="ses_background">
        <PlanModeBanner />
      </ComposerSessionProvider>
    )
    expect(screen.queryByTestId("plan-mode-banner")).not.toBeInTheDocument()
  })

  it("shows plan mode for a background pane that is itself in plan mode", () => {
    act(() => {
      useChatStore.getState().setActiveSession("ses_focused")
      useChatStore.getState().setPermissionMode(null, "ses_focused")
      useChatStore.getState().setPermissionMode("plan", "ses_background")
    })

    render(
      <ComposerSessionProvider value="ses_background">
        <PlanModeBanner />
      </ComposerSessionProvider>
    )
    expect(screen.getByTestId("plan-mode-banner")).toBeInTheDocument()
  })
})
