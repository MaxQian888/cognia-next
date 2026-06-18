/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DiscoverCardActions } from "./discover-card-actions"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import type { Character } from "@/lib/claude/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

// The share button pulls in the real ShareLinkDialog; stub it so the action
// sheet test stays focused on its own wiring.
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-share-dialog" /> : null,
}))

function characterItem(): DiscoverItem {
  const character = {
    id: "c1",
    name: "Researcher",
    avatarColor: "#abc",
    systemPrompt: "Be helpful.",
  } as unknown as Character
  return { kind: "character", id: "c1", data: character }
}

const pluginItem = {
  kind: "plugin",
  id: "p1",
  data: { id: "p1", name: "Clipboard" },
} as unknown as DiscoverItem

describe("DiscoverCardActions", () => {
  it("stays closed when no item is selected", () => {
    render(<DiscoverCardActions item={null} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("discover-card-actions-sheet")).not.toBeInTheDocument()
  })

  it("renders the share action and the item name for a shareable card", () => {
    render(<DiscoverCardActions item={characterItem()} onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("discover-card-actions-sheet")).toBeInTheDocument()
    expect(screen.getByText("Researcher")).toBeInTheDocument()
    expect(screen.getByTestId("discover-share-button")).toBeInTheDocument()
  })

  it("falls back to the generic title and hides share for a non-shareable kind", () => {
    render(<DiscoverCardActions item={pluginItem} onOpenChange={jest.fn()} />)
    // Non-shareable → DiscoverShareButton renders null.
    expect(screen.queryByTestId("discover-share-button")).not.toBeInTheDocument()
    // Plugin has a name, so the heading shows it rather than the generic title.
    expect(screen.getByText("Clipboard")).toBeInTheDocument()
  })

  it("invokes onOpenChange when dismissed", async () => {
    const onOpenChange = jest.fn()
    render(<DiscoverCardActions item={characterItem()} onOpenChange={onOpenChange} />)
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
