import { fireEvent, render, screen } from "@testing-library/react"
import { FullRestoreDialog } from "./full-restore-dialog"

const mockPick = jest.fn()
jest.mock("@/hooks/data/use-import-flow", () => ({
  useImportFlow: () => ({ state: { status: "idle" }, pickFile: mockPick, reset: jest.fn() }),
}))

it("adapts restore settings to the card width and keeps file selection wired", () => {
  const { container } = render(<FullRestoreDialog />)
  expect(container.firstChild).toHaveClass("@container/full-restore", "[overflow-wrap:anywhere]")
  const trigger = screen.getByRole("combobox")
  expect(trigger).toHaveClass("max-w-full", "min-w-0")
  expect(trigger.parentElement?.parentElement).toHaveClass("@md/full-restore:grid-cols-2")
  fireEvent.click(screen.getByRole("button", { name: "Choose file…" }))
  expect(mockPick).toHaveBeenCalled()
})
