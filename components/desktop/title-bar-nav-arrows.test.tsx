/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

const push = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TitleBarNavArrows } from "./title-bar-nav-arrows"
import { recordNavigation, resetNavHistory } from "@/hooks/desktop/use-nav-history"

beforeEach(() => {
  push.mockClear()
  resetNavHistory()
})

describe("TitleBarNavArrows", () => {
  it("renders both arrows disabled when there is no history", () => {
    render(<TitleBarNavArrows />)
    expect(screen.getByTestId("title-bar-nav-back")).toBeDisabled()
    expect(screen.getByTestId("title-bar-nav-forward")).toBeDisabled()
  })

  it("enables back once two paths are visited and navigates on click", () => {
    render(<TitleBarNavArrows />)
    act(() => {
      recordNavigation("/a")
      recordNavigation("/b")
    })
    const back = screen.getByTestId("title-bar-nav-back")
    expect(back).not.toBeDisabled()
    fireEvent.click(back)
    expect(push).toHaveBeenLastCalledWith("/a")
  })

  it("enables forward after going back, and navigates forward on click", () => {
    render(<TitleBarNavArrows />)
    act(() => {
      recordNavigation("/a")
      recordNavigation("/b")
    })
    fireEvent.click(screen.getByTestId("title-bar-nav-back"))
    const forward = screen.getByTestId("title-bar-nav-forward")
    expect(forward).not.toBeDisabled()
    fireEvent.click(forward)
    expect(push).toHaveBeenLastCalledWith("/b")
  })

  it("exposes accessible labels", () => {
    render(<TitleBarNavArrows />)
    expect(screen.getByTestId("title-bar-nav-back")).toHaveAttribute("aria-label", "back")
    expect(screen.getByTestId("title-bar-nav-forward")).toHaveAttribute("aria-label", "forward")
  })
})
