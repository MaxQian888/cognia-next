/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalQuickFix } from "./terminal-quick-fix"
import type { QuickFixAction } from "@/lib/terminal/quick-fix/matchers"

const actions: QuickFixAction[] = [
  {
    type: "run-command",
    id: "git-push-set-upstream:feature/x",
    labelKey: "runCommand",
    labelArgs: { command: "git push --set-upstream origin feature/x" },
    command: "git push --set-upstream origin feature/x",
    addNewLine: true,
  },
  {
    type: "kill-port",
    id: "free-port:3000",
    labelKey: "freePort",
    port: 3000,
    command: "npm run dev",
  },
]

const base = { actions, left: 5, top: 8, onRun: jest.fn(), open: false, onOpenChange: jest.fn() }

beforeEach(() => jest.clearAllMocks())

describe("TerminalQuickFix", () => {
  it("renders nothing when there are no actions", () => {
    const { container } = render(<TerminalQuickFix {...base} actions={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("shows a lightbulb trigger and requests open on click", () => {
    const props = { ...base, onOpenChange: jest.fn() }
    render(<TerminalQuickFix {...props} />)
    expect(screen.queryByTestId("terminal-quick-fix-menu")).not.toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId("terminal-quick-fix-trigger"))
    expect(props.onOpenChange).toHaveBeenCalledWith(true)
  })

  it("renders the action menu when open", () => {
    render(<TerminalQuickFix {...base} open />)
    expect(screen.getByTestId("terminal-quick-fix-menu")).toBeInTheDocument()
    expect(
      screen.getByTestId("terminal-quick-fix-action-git-push-set-upstream:feature/x")
    ).toBeInTheDocument()
    expect(screen.getByTestId("terminal-quick-fix-action-free-port:3000")).toBeInTheDocument()
  })

  it("dispatches the chosen action and requests close", () => {
    const props = { ...base, onRun: jest.fn(), onOpenChange: jest.fn() }
    render(<TerminalQuickFix {...props} open />)
    fireEvent.mouseDown(screen.getByTestId("terminal-quick-fix-action-free-port:3000"))
    expect(props.onRun).toHaveBeenCalledWith(actions[1])
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("requests close on Escape", () => {
    const props = { ...base, onOpenChange: jest.fn() }
    render(<TerminalQuickFix {...props} open />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("requests close on backdrop click", () => {
    const props = { ...base, onOpenChange: jest.fn() }
    render(<TerminalQuickFix {...props} open />)
    fireEvent.mouseDown(screen.getByTestId("terminal-quick-fix-backdrop"))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
