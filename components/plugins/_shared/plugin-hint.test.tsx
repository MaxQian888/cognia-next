/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/ui/use-pointer", () => ({
  useHasHover: jest.fn(() => false),
}))

import { useHasHover } from "@/hooks/ui/use-pointer"

import { PluginHint } from "./plugin-hint"

describe("PluginHint", () => {
  beforeEach(() => {
    ;(useHasHover as jest.Mock).mockReturnValue(false)
  })

  it("renders a focusable, named button trigger", () => {
    render(
      <PluginHint label="Signature unverified" content="No publisher signature.">
        <span aria-hidden>!</span>
      </PluginHint>
    )
    const trigger = screen.getByRole("button", { name: "Signature unverified" })
    expect(trigger).toHaveAttribute("type", "button")
    expect(trigger).toHaveClass("touch-hit")
  })

  it("opens on tap where nothing can hover", async () => {
    const user = userEvent.setup()
    render(
      <PluginHint label="Why" content="Because the desktop runs it.">
        ?
      </PluginHint>
    )
    expect(screen.queryByText("Because the desktop runs it.")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Why" }))
    expect(screen.getByText("Because the desktop runs it.")).toBeInTheDocument()
  })

  it("uses a tooltip where the pointer can hover, reachable by keyboard focus", async () => {
    ;(useHasHover as jest.Mock).mockReturnValue(true)
    const user = userEvent.setup()
    render(
      <PluginHint label="Why" content="Because the desktop runs it.">
        ?
      </PluginHint>
    )
    await user.tab()
    expect(screen.getByRole("button", { name: "Why" })).toHaveFocus()
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Because the desktop runs it.")
  })
})
