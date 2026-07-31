/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExternalAgentCommands } from "./commands"
import type { AcpAvailableCommand } from "@/types/agent/external-agent"

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

  it("passes undefined args for a command with no input", () => {
    const onExecute = jest.fn()
    renderCmds({ onExecute })
    fireEvent.click(screen.getByRole("button", { name: /commands/i }))
    fireEvent.click(screen.getByRole("button", { name: /Run \/ping/i }))
    expect(onExecute).toHaveBeenCalledWith("/ping", undefined)
  })
})
