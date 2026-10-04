import { render } from "@testing-library/react"

jest.mock("@/components/conversations/conversation-manager", () => ({
  ConversationManager: () => <div data-testid="conversation-manager" />,
}))

import ConversationsPage from "./page"

it("hosts the conversation manager in a full-height wrapper", () => {
  const { container, getByTestId } = render(<ConversationsPage />)
  expect(getByTestId("conversation-manager")).toBeInTheDocument()
  expect(container.firstElementChild).toHaveClass("h-full", "min-h-0", "flex-1")
})
