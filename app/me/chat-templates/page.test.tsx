/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/chat-templates-section", () => ({
  ChatTemplatesSection: ({ mobile }: { mobile?: boolean }) => (
    <div data-testid="chat-templates-section" data-mobile={mobile ? "true" : "false"} />
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

import MobileChatTemplatesPage from "./page"

describe("MobileChatTemplatesPage", () => {
  it("renders the sub-page shell with the chat-templates title", () => {
    render(<MobileChatTemplatesPage />)
    expect(screen.getByTestId("mobile-chat-templates-page")).toBeInTheDocument()
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("passes the mobile flag down, so the editor collapses to one column", () => {
    render(<MobileChatTemplatesPage />)
    expect(screen.getByTestId("chat-templates-section")).toHaveAttribute("data-mobile", "true")
  })

  /**
   * Deliberately NOT wrapped in `PairedOnly`: the table is device-local and the
   * phone's own composer writes into it, so a desktop pairing is irrelevant to
   * everything this page does.
   */
  it("does not gate on a paired desktop", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./page.tsx", import.meta.url).pathname, "utf8")
    )
    // The comment at the top of the page says the same thing in prose, so the
    // assertion is on the IMPORT rather than on the word.
    expect(source).not.toMatch(/import\s[^\n]*PairedOnly/)
  })

  it("wires the back-aria for the shell header", () => {
    const { container } = render(<MobileChatTemplatesPage />)
    const header = container.querySelector("header")
    expect(header).toHaveAttribute("data-back-aria", "backAria")
  })
})
