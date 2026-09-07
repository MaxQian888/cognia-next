/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { BotCredentialsSection } from "./credentials-section"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "needs_setup",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [],
    armedTriggers: 0,
    unboundSlots: ["token"],
    requiredSlots: [],
    credentials: [
      { id: "token", label: "GitHub token", optional: false, bound: false, integration: "github" },
      {
        id: "chat",
        label: "Chat account",
        optional: false,
        bound: true,
        adapterId: "adp_7",
      },
      { id: "extra", label: "Analytics", optional: true, bound: false },
    ],
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

describe("BotCredentialsSection", () => {
  it("flags the required slot that is unbound, which is why the status says needs_setup", () => {
    render(<BotCredentialsSection row={row()} />)
    const token = screen.getByTestId("bot-credential-token")
    expect(token).toHaveAttribute("data-bound", "false")
    expect(token).toHaveTextContent("Needs binding")
  })

  it("does not flag an unbound OPTIONAL slot", () => {
    // The Bot runs fine without it, and marking it would put a permanent
    // amber dot on a working installation.
    render(<BotCredentialsSection row={row()} />)
    const extra = screen.getByTestId("bot-credential-extra")
    expect(extra).toHaveTextContent("Optional")
    expect(extra).not.toHaveTextContent("Needs binding")
  })

  it("shows the id a binding points at, never a secret", () => {
    render(<BotCredentialsSection row={row()} />)
    expect(screen.getByTestId("bot-credential-chat")).toHaveTextContent("Bound to adp_7")
  })

  it("names the integration a slot must belong to", () => {
    render(<BotCredentialsSection row={row()} />)
    expect(screen.getByTestId("bot-credential-token")).toHaveTextContent("github")
  })

  it("distinguishes a Bot that needs no credentials from one with no definition", () => {
    const { unmount } = render(<BotCredentialsSection row={row({ credentials: [] })} />)
    expect(screen.getByText("No credentials needed")).toBeInTheDocument()
    unmount()

    render(<BotCredentialsSection row={row({ credentials: [], orphaned: true })} />)
    expect(screen.getByText("Definition missing")).toBeInTheDocument()
  })
})
