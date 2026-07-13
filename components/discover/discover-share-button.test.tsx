/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DiscoverShareButton } from "./discover-share-button"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import type { Character } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

// Stub the share dialog: when open, expose the built payload's data so the
// test can assert clean vs redacted content reached the dialog.
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({
    open,
    buildPayload,
  }: {
    open: boolean
    buildPayload: () => { data: string }
  }) => (open ? <div data-testid="stub-share-dialog" data-payload={buildPayload().data} /> : null),
}))

function characterItem(systemPrompt: string): DiscoverItem {
  const character = {
    id: "c1",
    name: "Researcher",
    avatarColor: "#abc",
    systemPrompt,
  } as unknown as Character
  return { kind: "character", id: "c1", data: character }
}

const pluginItem = {
  kind: "plugin",
  id: "p1",
  data: { id: "p1", name: "P" },
} as unknown as DiscoverItem

describe("DiscoverShareButton", () => {
  it("renders nothing for a non-shareable kind", () => {
    render(<DiscoverShareButton item={pluginItem} />)
    expect(screen.queryByTestId("discover-share-button")).not.toBeInTheDocument()
  })

  it("opens the share dialog directly for a clean definition", async () => {
    const user = userEvent.setup()
    render(<DiscoverShareButton item={characterItem("Be helpful.")} />)
    await user.click(screen.getByTestId("discover-share-button"))
    expect(screen.queryByTestId("discover-share-redacted")).not.toBeInTheDocument()
    const dialog = screen.getByTestId("stub-share-dialog")
    expect(dialog.getAttribute("data-payload")).toContain("Be helpful.")
  })

  it("routes through the PII confirm and can share the redacted definition", async () => {
    const user = userEvent.setup()
    render(<DiscoverShareButton item={characterItem("Email alice@example.com")} />)
    await user.click(screen.getByTestId("discover-share-button"))
    // Confirm step appears; share dialog not yet open.
    expect(screen.getByTestId("discover-share-redacted")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-share-dialog")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("discover-share-redacted"))
    const dialog = screen.getByTestId("stub-share-dialog")
    expect(dialog.getAttribute("data-payload")).not.toContain("alice@example.com")
    expect(dialog.getAttribute("data-payload")).toContain("<EMAIL_001>")
  })

  it("can share the original definition when the user overrides the PII warning", async () => {
    const user = userEvent.setup()
    render(<DiscoverShareButton item={characterItem("Email alice@example.com")} />)
    await user.click(screen.getByTestId("discover-share-button"))
    await user.click(screen.getByTestId("discover-share-original"))
    expect(screen.getByTestId("stub-share-dialog").getAttribute("data-payload")).toContain(
      "alice@example.com"
    )
  })

  it("cancels the PII confirm without opening the share dialog", async () => {
    const user = userEvent.setup()
    render(<DiscoverShareButton item={characterItem("Email alice@example.com")} />)
    await user.click(screen.getByTestId("discover-share-button"))
    await user.click(screen.getByTestId("discover-share-cancel"))
    expect(screen.queryByTestId("stub-share-dialog")).not.toBeInTheDocument()
  })
})
