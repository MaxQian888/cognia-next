/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

jest.mock("@/components/conversations/auto-archive-control", () => ({
  AutoArchiveControl: ({ variant }: { variant?: string }) => (
    <div data-testid="auto-archive-control" data-variant={variant} />
  ),
}))

import { ConversationArchiveCard } from "./conversation-archive-card"

test("frames the shared auto-archive control as a settings card", () => {
  render(<ConversationArchiveCard />)
  expect(screen.getByText("conversations.autoArchive.card.title")).toBeInTheDocument()
  expect(screen.getByText("conversations.autoArchive.card.description")).toBeInTheDocument()
  expect(screen.getByTestId("auto-archive-control")).toHaveAttribute("data-variant", "card")
})
