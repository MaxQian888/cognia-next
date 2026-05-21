/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/prompt-presets-section", () => ({
  PromptPresetsSection: ({ mobile }: { mobile?: boolean }) => (
    <div data-testid="prompt-presets-section" data-mobile={mobile ? "true" : "false"} />
  ),
}))

jest.mock("@/components/mobile/me/sub-page-shell", () => ({
  SubPageShell: ({
    title,
    backAria,
    testid,
    children,
  }: {
    title: string
    backAria: string
    testid?: string
    children: React.ReactNode
  }) => (
    <main data-testid={testid}>
      <header data-back-aria={backAria}>{title}</header>
      {children}
    </main>
  ),
}))

import MobilePresetsPage from "./page"

describe("MobilePresetsPage", () => {
  it("renders the sub-page shell with the presets row title", () => {
    render(<MobilePresetsPage />)
    expect(screen.getByTestId("mobile-presets-page")).toBeInTheDocument()
    expect(screen.getByText("presetsRow")).toBeInTheDocument()
  })

  it("passes the mobile flag to PromptPresetsSection", () => {
    render(<MobilePresetsPage />)
    expect(screen.getByTestId("prompt-presets-section")).toHaveAttribute("data-mobile", "true")
  })

  it("wires the back-aria for the shell header", () => {
    const { container } = render(<MobilePresetsPage />)
    const header = container.querySelector("header")
    expect(header).toHaveAttribute("data-back-aria", "presetsBackAria")
  })
})
