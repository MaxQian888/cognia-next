/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Command } from "@/components/ui/command"
import { ChatHistorySearchResults } from "./chat-history-search-results"

const result = {
  messageId: "m1",
  sessionId: "s1",
  sessionTitle: "Planning",
  projectId: "p1",
  role: "user",
  createdAt: 1,
  count: 1,
  at: 6,
  snippet: { text: "Book needle flights", positions: [5, 6, 7, 8, 9, 10] },
  score: 1,
  archived: false,
  otherBranchCount: 0,
}

test("renders highlighted message hits and selects the exact result", async () => {
  const onSelect = jest.fn()
  const user = userEvent.setup()
  const { container } = render(
    <Command>
      <ChatHistorySearchResults
        query="needle"
        results={[result]}
        loading={false}
        error={null}
        coverageIncomplete={false}
        heading="Messages"
        loadingLabel="Searching"
        errorLabel="Unavailable"
        coverageLabel="Incomplete"
        onSelect={onSelect}
      />
    </Command>
  )

  expect(screen.getByText("Planning")).toBeInTheDocument()
  expect(container.querySelector("mark")).toHaveTextContent("needle")
  await user.click(screen.getByText("Planning"))
  expect(onSelect).toHaveBeenCalledWith(result)
})

test("keeps loading, error, and coverage feedback inside the result group", () => {
  const { rerender } = render(
    <Command>
      <ChatHistorySearchResults
        query="needle"
        results={[]}
        loading
        error={null}
        coverageIncomplete={false}
        heading="Messages"
        loadingLabel="Searching"
        errorLabel="Unavailable"
        coverageLabel="Incomplete"
        onSelect={jest.fn()}
      />
    </Command>
  )
  expect(screen.getByText("Searching").closest("[cmdk-item]")).toHaveAttribute(
    "aria-disabled",
    "true"
  )

  rerender(
    <Command>
      <ChatHistorySearchResults
        query="needle"
        results={[]}
        loading={false}
        error={new Error("offline")}
        coverageIncomplete
        heading="Messages"
        loadingLabel="Searching"
        errorLabel="Unavailable"
        coverageLabel="Incomplete"
        onSelect={jest.fn()}
      />
    </Command>
  )
  expect(screen.getByText("Unavailable")).toBeInTheDocument()
  expect(screen.getByText("Incomplete")).toBeInTheDocument()
})
