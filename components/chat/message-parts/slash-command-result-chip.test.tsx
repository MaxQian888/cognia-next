/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { SlashCommandResultChip, type SlashCommandResultBlock } from "./slash-command-result-chip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("SlashCommandResultChip", () => {
  it("renders the command id with leading slash and a default summary", () => {
    const block: SlashCommandResultBlock = { kind: "slash-result", commandId: "clear" }
    render(<SlashCommandResultChip block={block} />)
    const chip = screen.getByTestId("slash-command-result")
    expect(chip.dataset.command).toBe("clear")
    expect(chip.textContent).toMatch(/\/clear/)
    expect(screen.getByText("ranSlashCommand")).toBeInTheDocument()
  })

  it("renders the user-supplied summary when present", () => {
    const block: SlashCommandResultBlock = {
      kind: "slash-result",
      commandId: "model",
      summary: "Switched to claude-haiku.",
    }
    render(<SlashCommandResultChip block={block} />)
    expect(screen.getByText("Switched to claude-haiku.")).toBeInTheDocument()
    expect(screen.queryByText("ranSlashCommand")).not.toBeInTheDocument()
  })

  it("renders args inline next to the command name", () => {
    const block: SlashCommandResultBlock = {
      kind: "slash-result",
      commandId: "review",
      args: "auth flow",
    }
    render(<SlashCommandResultChip block={block} />)
    expect(screen.getByTestId("slash-command-result").textContent).toMatch(/auth flow/)
  })
})
