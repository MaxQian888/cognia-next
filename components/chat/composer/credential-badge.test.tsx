import { fireEvent, render, screen } from "@testing-library/react"
import { ComposerCredentialBadge } from "./credential-badge"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockCredentialStatus = jest.fn(() => ({ keyOk: true as boolean | null, plan: null }))
jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: () => mockCredentialStatus(),
}))

describe("ComposerCredentialBadge", () => {
  it("renders nothing while a key or subscription bearer is configured", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    render(<ComposerCredentialBadge />)
    expect(screen.queryByTestId("composer-credential-badge")).toBeNull()
  })

  it("stays quiet while the status is still resolving", () => {
    // `null` = not yet known; only a definite `false` warns.
    mockCredentialStatus.mockReturnValue({ keyOk: null, plan: null })
    render(<ComposerCredentialBadge />)
    expect(screen.queryByTestId("composer-credential-badge")).toBeNull()
  })

  it("warns, and opens provider settings on click, when no credential exists", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    const onOpenSettings = jest.fn()
    render(<ComposerCredentialBadge onOpenSettings={onOpenSettings} />)
    const badge = screen.getByTestId("composer-credential-badge")
    expect(badge).toHaveTextContent("noApiKey")
    expect(badge).toHaveAttribute("role", "button")
    fireEvent.click(badge)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})
