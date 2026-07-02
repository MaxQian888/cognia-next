/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import { PlanModeBanner } from "./plan-mode-banner"
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
})
