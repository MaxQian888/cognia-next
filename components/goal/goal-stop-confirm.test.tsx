import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GoalStopConfirm } from "./goal-stop-confirm"

// next-intl globally mocked against en.json in jest.setup.ts.

describe("GoalStopConfirm", () => {
  it("renders nothing while closed", () => {
    render(
      <GoalStopConfirm
        open={false}
        onOpenChange={jest.fn()}
        objective="ship it"
        onConfirm={jest.fn()}
      />
    )
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("explains that stopping is final and quotes the objective", () => {
    render(
      <GoalStopConfirm open onOpenChange={jest.fn()} objective="ship it" onConfirm={jest.fn()} />
    )
    const dialog = screen.getByRole("alertdialog", { name: "Stop this goal?" })
    expect(dialog).toHaveAccessibleDescription(
      "A stopped goal can't be resumed. You can run it again later as a new goal."
    )
    expect(within(dialog).getByText("ship it")).toBeInTheDocument()
  })

  it("calls onConfirm from the destructive Stop goal button", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    const onOpenChange = jest.fn()
    render(<GoalStopConfirm open onOpenChange={onOpenChange} objective="x" onConfirm={onConfirm} />)
    await user.click(screen.getByRole("button", { name: "Stop goal" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // The Radix action also closes the dialog.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("Keep running closes without confirming", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    const onOpenChange = jest.fn()
    render(<GoalStopConfirm open onOpenChange={onOpenChange} objective="x" onConfirm={onConfirm} />)
    await user.click(screen.getByRole("button", { name: "Keep running" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("Escape closes without confirming", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    const onOpenChange = jest.fn()
    render(<GoalStopConfirm open onOpenChange={onOpenChange} objective="x" onConfirm={onConfirm} />)
    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
