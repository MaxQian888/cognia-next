import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerCredentialBadge } from "./credential-badge"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockCredentialStatus = jest.fn(() => ({ keyOk: true as boolean | null, plan: null }))
jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: () => mockCredentialStatus(),
}))

function renderBadge(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe("ComposerCredentialBadge", () => {
  it("renders nothing while a key or subscription bearer is configured", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    renderBadge(<ComposerCredentialBadge />)
    expect(screen.queryByTestId("composer-credential-badge")).toBeNull()
  })

  it("stays quiet while the status is still resolving", () => {
    // `null` = not yet known; only a definite `false` warns.
    mockCredentialStatus.mockReturnValue({ keyOk: null, plan: null })
    renderBadge(<ComposerCredentialBadge />)
    expect(screen.queryByTestId("composer-credential-badge")).toBeNull()
  })

  it("warns, and opens provider settings on click, when no credential exists", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    const onOpenSettings = jest.fn()
    renderBadge(<ComposerCredentialBadge onOpenSettings={onOpenSettings} />)
    const badge = screen.getByRole("button", { name: "noApiKey" })
    expect(badge).toHaveAttribute("data-testid", "composer-credential-badge")
    fireEvent.click(badge)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  // It used to be a `span role="button"` that Tab walked straight past.
  it("is a real button the keyboard can reach", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge onOpenSettings={jest.fn()} />)
    const badge = screen.getByTestId("composer-credential-badge")
    expect(badge.tagName).toBe("BUTTON")
    badge.focus()
    expect(badge).toHaveFocus()
  })

  it("wears the toolbar row's chip geometry, not a pill badge's", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge onOpenSettings={jest.fn()} />)
    const badge = screen.getByTestId("composer-credential-badge")
    expect(badge.className).toContain("h-7")
    expect(badge.className).toContain("rounded-md")
    expect(badge.className).toContain("text-destructive")
    expect(badge.className).not.toMatch(/(^|\s)text-muted-foreground(\s|$)/)
  })

  it("folds to the key glyph and keeps saying what is wrong", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge onOpenSettings={jest.fn()} glyph />)
    const badge = screen.getByRole("button", { name: "noApiKey" })
    expect(badge).toHaveAttribute("data-glyph", "true")
    expect(badge).not.toHaveTextContent("noApiKey")
    expect(badge.className).toContain("w-7")
  })

  it("is a status, not a dead button, when there is nowhere to send the user", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByRole("status", { name: "noApiKey" })).toBeInTheDocument()
  })
})
