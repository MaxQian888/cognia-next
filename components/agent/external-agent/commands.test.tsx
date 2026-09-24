/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExternalAgentCommands } from "./commands"
import type { AcpAvailableCommand } from "@/types/agent/external-agent"
import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"

const cmds: AcpAvailableCommand[] = [
  { name: "review", description: "Review the diff", input: { hint: "path" } },
  { name: "ping", description: "Health check", input: null },
]

const renderCmds = (props: Partial<React.ComponentProps<typeof ExternalAgentCommands>> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <TooltipProvider>
        <ExternalAgentCommands commands={cmds} onExecute={() => {}} {...props} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )

describe("ExternalAgentCommands", () => {
  it("returns null when there are no commands", () => {
    const { container } = renderCmds({ commands: [] })
    expect(container).toBeEmptyDOMElement()
  })

  it("opens the popover and lists commands", () => {
    renderCmds()
    fireEvent.click(screen.getByRole("button", { name: /commands/i }))
    expect(screen.getByText("/review")).toBeInTheDocument()
    expect(screen.getByText("/ping")).toBeInTheDocument()
  })

  it("gives the run button an accessible label and fires onExecute", () => {
    const onExecute = jest.fn()
    renderCmds({ onExecute })
    fireEvent.click(screen.getByRole("button", { name: /commands/i }))
    const runReview = screen.getByRole("button", { name: /Run \/review/i })
    expect(runReview).toBeInTheDocument()
    fireEvent.click(runReview)
    // The command takes input (hint shown as a badge) but no inline field sets
    // args, so the empty-string default is passed through.
    expect(onExecute).toHaveBeenCalledWith("/review", "")
  })

  it("keeps the run button reachable without a hover", () => {
    const onExecute = jest.fn()
    renderCmds({ onExecute })
    fireEvent.click(screen.getByRole("button", { name: /commands/i }))
    const runPing = screen.getByRole("button", { name: /Run \/ping/i })
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.control) {
      expect(runPing).toHaveClass(variant)
    }
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(runPing).not.toHaveClass(forbidden)
    }
    runPing.focus()
    expect(runPing).toHaveFocus()
    fireEvent.click(runPing)
    expect(onExecute).toHaveBeenCalledWith("/ping", undefined)
  })

  it("passes undefined args for a command with no input", () => {
    const onExecute = jest.fn()
    renderCmds({ onExecute })
    fireEvent.click(screen.getByRole("button", { name: /commands/i }))
    fireEvent.click(screen.getByRole("button", { name: /Run \/ping/i }))
    expect(onExecute).toHaveBeenCalledWith("/ping", undefined)
  })
})
