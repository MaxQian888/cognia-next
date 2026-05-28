import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { IMQuickCommand } from "@/lib/connectors/quick-commands"
import { QuickCommandsEditor } from "./quick-commands-editor"

describe("QuickCommandsEditor", () => {
  function setup(value: IMQuickCommand[] = []) {
    const onChange = jest.fn<void, [IMQuickCommand[]]>()
    render(
      <QuickCommandsEditor
        value={value}
        onChange={onChange}
        helpText="explainer text"
        testIdPrefix="t"
      />
    )
    return { onChange }
  }

  it("renders the caller's help text verbatim", () => {
    setup()
    expect(screen.getByText("explainer text")).toBeInTheDocument()
  })

  it("shows the empty-state copy when the list is empty", () => {
    setup()
    expect(screen.getByText("No quick commands mapped yet.")).toBeInTheDocument()
  })

  it("appends a new command via the Add button + clears the inputs", async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.type(screen.getByTestId("t-trigger-key"), "menu.help")
    await user.type(screen.getByTestId("t-label"), "Help")
    await user.type(screen.getByTestId("t-value"), "show help")
    await user.click(screen.getByTestId("t-add"))
    expect(onChange).toHaveBeenCalledWith([
      {
        triggerKey: "menu.help",
        label: "Help",
        action: { type: "prompt", value: "show help" },
      },
    ])
    expect((screen.getByTestId("t-trigger-key") as HTMLInputElement).value).toBe("")
  })

  it("omits the optional label when blank", async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.type(screen.getByTestId("t-trigger-key"), "menu.x")
    await user.type(screen.getByTestId("t-value"), "do x")
    await user.click(screen.getByTestId("t-add"))
    expect(onChange).toHaveBeenCalledWith([
      { triggerKey: "menu.x", action: { type: "prompt", value: "do x" } },
    ])
  })

  it("ignores Add when triggerKey or value is empty", async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByTestId("t-add"))
    expect(onChange).not.toHaveBeenCalled()
    await user.type(screen.getByTestId("t-trigger-key"), "menu.x")
    await user.click(screen.getByTestId("t-add"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("rejects a duplicate triggerKey", async () => {
    const user = userEvent.setup()
    const { onChange } = setup([{ triggerKey: "menu.x", action: { type: "prompt", value: "x" } }])
    await user.type(screen.getByTestId("t-trigger-key"), "menu.x")
    await user.type(screen.getByTestId("t-value"), "x2")
    await user.click(screen.getByTestId("t-add"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("removes a command via the per-row delete button", async () => {
    const user = userEvent.setup()
    const { onChange } = setup([
      { triggerKey: "menu.a", action: { type: "prompt", value: "a" } },
      { triggerKey: "menu.b", action: { type: "slash", value: "/b" } },
    ])
    await user.click(screen.getByTestId("t-remove-menu.a"))
    expect(onChange).toHaveBeenCalledWith([
      { triggerKey: "menu.b", action: { type: "slash", value: "/b" } },
    ])
  })

  it("submits on Enter inside the value field", () => {
    const onChange = jest.fn<void, [IMQuickCommand[]]>()
    render(<QuickCommandsEditor value={[]} onChange={onChange} helpText="h" testIdPrefix="t" />)
    fireEvent.change(screen.getByTestId("t-trigger-key"), { target: { value: "menu.x" } })
    fireEvent.change(screen.getByTestId("t-value"), { target: { value: "do x" } })
    fireEvent.keyDown(screen.getByTestId("t-value"), { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith([
      { triggerKey: "menu.x", action: { type: "prompt", value: "do x" } },
    ])
  })

  it("disables every control when disabled", () => {
    render(
      <QuickCommandsEditor
        value={[{ triggerKey: "menu.x", action: { type: "prompt", value: "x" } }]}
        onChange={jest.fn()}
        helpText="h"
        disabled
        testIdPrefix="t"
      />
    )
    expect(screen.getByTestId("t-trigger-key")).toBeDisabled()
    expect(screen.getByTestId("t-value")).toBeDisabled()
    expect(screen.getByTestId("t-add")).toBeDisabled()
    expect(screen.getByTestId("t-remove-menu.x")).toBeDisabled()
  })
})
