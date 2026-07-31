import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { NumberRow } from "./number-row"

function setup(over: Partial<React.ComponentProps<typeof NumberRow>> = {}) {
  const onCommit = jest.fn()
  render(
    <NumberRow
      id="gw-port"
      label="Port"
      value={47823}
      min={1024}
      max={65535}
      onCommit={onCommit}
      {...over}
    />
  )
  return { onCommit }
}

describe("NumberRow", () => {
  it("does not clamp while typing", async () => {
    // Regression: clamping per keystroke turned the first digit of "8080" into
    // 1024 (min), and typing could never recover from it.
    const user = userEvent.setup()
    const { onCommit } = setup()
    const input = screen.getByLabelText("Port")

    await user.clear(input)
    await user.type(input, "8080")

    expect(input).toHaveValue(8080)
    // These fields each cost a Tauri IPC plus a disk write, so nothing commits
    // until the edit is finished — `commitWhileTyping` is off.
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("clamps to the bounds on commit", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup()
    const input = screen.getByLabelText("Port")

    await user.clear(input)
    await user.type(input, "99999{Enter}")

    expect(onCommit).toHaveBeenCalledWith(65535)
  })

  it("reverts a cleared field to the stored value instead of committing one", async () => {
    // Blanking a field is not a request to jump anywhere — the previous local
    // copy of this input committed a `fallback` here, writing a value the user
    // never typed.
    const user = userEvent.setup()
    const { onCommit } = setup({ value: 5000 })
    const input = screen.getByLabelText("Port")

    await user.clear(input)
    expect(input).toHaveValue(null)

    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Port")).toHaveValue(5000)
  })

  it("abandons the edit on Escape", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup({ value: 5000 })
    const input = screen.getByLabelText("Port")

    await user.clear(input)
    await user.type(input, "9000{Escape}")

    expect(input).toHaveValue(5000)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("commits on blur", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup()
    const input = screen.getByLabelText("Port")

    await user.clear(input)
    await user.type(input, "9000")
    await user.tab()

    expect(onCommit).toHaveBeenCalledWith(9000)
  })

  it("does not fire when the committed value is unchanged", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup({ value: 9000 })
    const input = screen.getByLabelText("Port")

    await user.clear(input)
    await user.type(input, "9000{Enter}")

    expect(onCommit).not.toHaveBeenCalled()
  })

  it("tracks external value changes while not being edited", () => {
    const { rerender } = render(
      <NumberRow id="gw-port" label="Port" value={1} min={0} max={10} onCommit={jest.fn()} />
    )
    rerender(
      <NumberRow id="gw-port" label="Port" value={7} min={0} max={10} onCommit={jest.fn()} />
    )

    expect(screen.getByLabelText("Port")).toHaveValue(7)
  })

  it("renders optional help text", () => {
    setup({ help: "Bounds a hung connect." })

    expect(screen.getByText("Bounds a hung connect.")).toBeInTheDocument()
  })
})
