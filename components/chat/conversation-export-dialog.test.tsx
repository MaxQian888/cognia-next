/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next/dynamic", () => () => {
  function MockSingleExportDialog(props: {
    session: ChatSession
    open: boolean
    onOpenChange: (open: boolean) => void
  }) {
    return (
      <div data-testid="export-dialog" data-open={String(props.open)}>
        {props.session.title}
        <button type="button" onClick={() => props.onOpenChange(false)}>
          close
        </button>
      </div>
    )
  }
  return MockSingleExportDialog
})

import { ConversationExportDialog } from "./conversation-export-dialog"

const session = {
  id: "s1",
  title: "Standup",
  kind: "direct",
  createdAt: 1,
  updatedAt: 1,
} as ChatSession

test("renders nothing until a row asks to export", () => {
  render(<ConversationExportDialog session={null} onClose={jest.fn()} />)
  expect(screen.queryByTestId("export-dialog")).toBeNull()
})

test("opens for the asking row and reports its close", () => {
  const onClose = jest.fn()
  render(<ConversationExportDialog session={session} onClose={onClose} />)
  expect(screen.getByTestId("export-dialog")).toHaveTextContent("Standup")
  expect(screen.getByTestId("export-dialog")).toHaveAttribute("data-open", "true")
  fireEvent.click(screen.getByText("close"))
  expect(onClose).toHaveBeenCalledTimes(1)
})
