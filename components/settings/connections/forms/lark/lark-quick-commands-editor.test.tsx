/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LarkQuickCommandsEditor } from "./lark-quick-commands-editor"
import type { LarkQuickCommand } from "@/lib/connectors/adapters/lark/quick-commands"

function setup(value: LarkQuickCommand[] = []) {
  const onChange = jest.fn()
  render(<LarkQuickCommandsEditor value={value} onChange={onChange} />)
  return { onChange }
}

describe("LarkQuickCommandsEditor", () => {
  it("renders the empty state when there are no commands", () => {
    setup([])
    expect(screen.getByTestId("lark-quick-commands-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("lqc-list")).not.toBeInTheDocument()
  })

  it("adds a prompt command (default action type)", () => {
    const { onChange } = setup([])
    fireEvent.change(screen.getByTestId("lqc-event-key"), { target: { value: "summary" } })
    fireEvent.change(screen.getByTestId("lqc-value"), { target: { value: "Summarize my unread." } })
    fireEvent.click(screen.getByTestId("lqc-add"))
    expect(onChange).toHaveBeenCalledWith([
      { eventKey: "summary", action: { type: "prompt", value: "Summarize my unread." } },
    ])
  })

  it("includes the optional label when provided", () => {
    const { onChange } = setup([])
    fireEvent.change(screen.getByTestId("lqc-event-key"), { target: { value: "agenda" } })
    fireEvent.change(screen.getByTestId("lqc-label"), { target: { value: "今日日程" } })
    fireEvent.change(screen.getByTestId("lqc-value"), { target: { value: "/agenda" } })
    fireEvent.click(screen.getByTestId("lqc-add"))
    expect(onChange).toHaveBeenCalledWith([
      { eventKey: "agenda", label: "今日日程", action: { type: "prompt", value: "/agenda" } },
    ])
  })

  it("adds via Enter on the value field", () => {
    const { onChange } = setup([])
    fireEvent.change(screen.getByTestId("lqc-event-key"), { target: { value: "k" } })
    fireEvent.change(screen.getByTestId("lqc-value"), { target: { value: "v" } })
    fireEvent.keyDown(screen.getByTestId("lqc-value"), { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith([
      { eventKey: "k", action: { type: "prompt", value: "v" } },
    ])
  })

  it("does not add when eventKey or value is blank", () => {
    const { onChange } = setup([])
    fireEvent.change(screen.getByTestId("lqc-event-key"), { target: { value: "only-key" } })
    fireEvent.click(screen.getByTestId("lqc-add"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("does not add a duplicate eventKey", () => {
    const existing: LarkQuickCommand[] = [
      { eventKey: "dup", action: { type: "prompt", value: "first" } },
    ]
    const { onChange } = setup(existing)
    fireEvent.change(screen.getByTestId("lqc-event-key"), { target: { value: "dup" } })
    fireEvent.change(screen.getByTestId("lqc-value"), { target: { value: "second" } })
    fireEvent.click(screen.getByTestId("lqc-add"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("removes a command via its X button", () => {
    const existing: LarkQuickCommand[] = [
      { eventKey: "a", action: { type: "prompt", value: "pa" } },
      { eventKey: "b", action: { type: "slash", value: "/pb" } },
    ]
    const { onChange } = setup(existing)
    fireEvent.click(screen.getByTestId("lqc-remove-a"))
    expect(onChange).toHaveBeenCalledWith([
      { eventKey: "b", action: { type: "slash", value: "/pb" } },
    ])
  })

  it("adds a slash command when the action type is switched", async () => {
    const user = userEvent.setup()
    const { onChange } = setup([])
    await user.click(screen.getByTestId("lqc-action-type"))
    fireEvent.click(await screen.findByTestId("lqc-action-slash"))
    fireEvent.change(screen.getByTestId("lqc-event-key"), { target: { value: "agenda" } })
    fireEvent.change(screen.getByTestId("lqc-value"), { target: { value: "/agenda today" } })
    fireEvent.click(screen.getByTestId("lqc-add"))
    expect(onChange).toHaveBeenCalledWith([
      { eventKey: "agenda", action: { type: "slash", value: "/agenda today" } },
    ])
  })
})
