/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AddAgentDialog } from "./add-agent-dialog"

const useIsMobileMock = jest.fn(() => false)
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => useIsMobileMock() }))

jest.mock("@/components/agent/external-agent/add-agent/preset-picker-list", () => ({
  PresetPickerList: ({
    onPick,
    disabled,
    autoFocusSearch,
  }: {
    onPick: (id: string) => void
    disabled?: boolean
    autoFocusSearch?: boolean
  }) => (
    <div data-testid="preset-picker-list" data-auto-focus={autoFocusSearch}>
      <button disabled={disabled} onClick={() => onPick("codex")}>
        Codex
      </button>
      <button disabled={disabled} onClick={() => onPick("custom")}>
        Custom
      </button>
    </div>
  ),
}))

beforeEach(() => {
  useIsMobileMock.mockReturnValue(false)
})

describe("AddAgentDialog", () => {
  it.each([false, true])("uses the responsive picker shell with mobile=%s", (mobile) => {
    useIsMobileMock.mockReturnValue(mobile)
    render(<AddAgentDialog open onOpenChange={jest.fn()} onPick={jest.fn()} />)
    expect(screen.getByTestId(mobile ? "add-agent-drawer" : "add-agent-dialog")).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Add Agent" })).toBeInTheDocument()
    expect(screen.getByTestId("preset-picker-list")).toHaveAttribute("data-auto-focus", "true")
  })

  it.each(["Codex", "Custom"])("closes before handing off the %s choice", async (choice) => {
    const calls: (string | boolean)[] = []
    render(
      <AddAgentDialog
        open
        onOpenChange={(open) => calls.push(open)}
        onPick={(id) => calls.push(id)}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: choice }))
    expect(calls).toEqual([false, choice === "Codex" ? "codex" : "custom"])
  })

  it("forwards disabled and does not pick from a disabled dialog", async () => {
    const onPick = jest.fn()
    render(<AddAgentDialog open disabled onOpenChange={jest.fn()} onPick={onPick} />)
    const button = screen.getByRole("button", { name: "Codex" })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(onPick).not.toHaveBeenCalled()
  })

  it("dismisses without selecting and renders nothing while closed", async () => {
    const onOpenChange = jest.fn()
    const onPick = jest.fn()
    const view = render(<AddAgentDialog open onOpenChange={onOpenChange} onPick={onPick} />)
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onPick).not.toHaveBeenCalled()
    view.rerender(<AddAgentDialog open={false} onOpenChange={onOpenChange} onPick={onPick} />)
    expect(screen.queryByTestId("preset-picker-list")).toBeNull()
  })
})
