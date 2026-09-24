/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/lib/capacitor/haptics", () => ({
  impact: () => Promise.resolve({ kind: "ok" }),
}))

import { CREDENTIAL_HINT_MS, MobileCredentialWarning } from "./mobile-credential-warning"

const wrapper = ({ children }: { children: ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
)

describe("<MobileCredentialWarning />", () => {
  it("is a fixed, named icon button on a narrow bar — never a clipped label", () => {
    render(<MobileCredentialWarning showLabel={false} onResolve={jest.fn()} />, { wrapper })
    const button = screen.getByTestId("mobile-no-api-key")
    expect(button).toHaveAccessibleName("noApiKeyHint")
    expect(button).toHaveAttribute("data-compact", "true")
    expect(button).toHaveClass("touch-target", "shrink-0", "size-11")
    expect(button).not.toHaveTextContent("noApiKey")
  })

  it("grows its label once the bar has room", () => {
    render(<MobileCredentialWarning showLabel onResolve={jest.fn()} />, { wrapper })
    const button = screen.getByTestId("mobile-no-api-key")
    expect(button).toHaveTextContent("noApiKey")
    expect(button).not.toHaveAttribute("data-compact")
  })

  it("opens the fix on tap", async () => {
    const user = userEvent.setup()
    const onResolve = jest.fn()
    render(<MobileCredentialWarning showLabel={false} onResolve={onResolve} />, { wrapper })
    await user.click(screen.getByTestId("mobile-no-api-key"))
    expect(onResolve).toHaveBeenCalledTimes(1)
  })

  it("explains itself on a long-press, without also opening the fix, then lets go", () => {
    jest.useFakeTimers()
    try {
      const onResolve = jest.fn()
      render(<MobileCredentialWarning showLabel={false} onResolve={onResolve} />, { wrapper })
      const button = screen.getByTestId("mobile-no-api-key")
      fireEvent.pointerDown(button, { clientX: 0, clientY: 0, pointerType: "touch" })
      act(() => {
        jest.advanceTimersByTime(500)
      })
      fireEvent.pointerUp(button, { pointerType: "touch" })
      fireEvent.click(button)
      expect(onResolve).not.toHaveBeenCalled()
      expect(screen.getAllByText("noApiKeyHint").length).toBeGreaterThan(0)
      act(() => {
        jest.advanceTimersByTime(CREDENTIAL_HINT_MS)
      })
      expect(screen.queryByTestId("mobile-no-api-key-hint")).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })
})
