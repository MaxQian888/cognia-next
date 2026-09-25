/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import { toast } from "sonner"

import { CleanupRunsDialog } from "./cleanup-runs-dialog"

const toastMock = toast as unknown as { success: jest.Mock; info: jest.Mock; error: jest.Mock }

beforeEach(() => jest.clearAllMocks())

describe("CleanupRunsDialog", () => {
  it("asks first, then reports how many runs it removed", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn(async () => 12)
    const onOpenChange = jest.fn()
    render(
      <CleanupRunsDialog open onOpenChange={onOpenChange} maxAgeDays={30} onConfirm={onConfirm} />
    )
    expect(screen.getByText(/more than 30 days ago/)).toBeInTheDocument()
    await user.click(screen.getByTestId("cleanup-runs-confirm"))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Removed 12 old runs"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("says when there was nothing old enough, rather than a success with no count", async () => {
    const user = userEvent.setup()
    render(
      <CleanupRunsDialog open onOpenChange={jest.fn()} maxAgeDays={30} onConfirm={async () => 0} />
    )
    await user.click(screen.getByTestId("cleanup-runs-confirm"))
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledWith("No runs older than 30 days"))
  })

  it("stays open and says it failed when the clean-up throws", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(
      <CleanupRunsDialog
        open
        onOpenChange={onOpenChange}
        maxAgeDays={30}
        onConfirm={async () => {
          throw new Error("db locked")
        }}
      />
    )
    await user.click(screen.getByTestId("cleanup-runs-confirm"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.error.mock.calls[0][1]).toEqual({ description: "db locked" })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
