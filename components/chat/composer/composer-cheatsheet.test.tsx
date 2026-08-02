/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ComposerCheatsheet } from "./composer-cheatsheet"

describe("ComposerCheatsheet", () => {
  it("renders nothing while closed, so it costs no layout", () => {
    render(<ComposerCheatsheet open={false} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("composer-cheatsheet")).not.toBeInTheDocument()
  })

  it("documents every keyboard shortcut when open", () => {
    render(<ComposerCheatsheet open onOpenChange={jest.fn()} />)
    const sheet = screen.getByTestId("composer-cheatsheet")
    for (const key of [
      "keys.send",
      "keys.newline",
      "keys.permissionMode",
      "keys.history",
      "keys.complete",
      "keys.dismiss",
    ]) {
      expect(sheet).toHaveTextContent(key)
    }
  })

  it("documents all four input prefixes", () => {
    render(<ComposerCheatsheet open onOpenChange={jest.fn()} />)
    const sheet = screen.getByTestId("composer-cheatsheet")
    for (const key of ["prefixes.slash", "prefixes.mention", "prefixes.shell", "prefixes.memory"]) {
      expect(sheet).toHaveTextContent(key)
    }
  })

  it("shows the literal keycaps and prefix characters", () => {
    render(<ComposerCheatsheet open onOpenChange={jest.fn()} />)
    const caps = screen.getAllByText((_, el) => el?.tagName === "KBD").map((el) => el.textContent)
    expect(caps).toEqual(expect.arrayContaining(["⏎", "⇧", "⇥", "Esc", "/", "@", "!", "#"]))
  })

  it("explains the same-line chaining rule", () => {
    render(<ComposerCheatsheet open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("composer-cheatsheet")).toHaveTextContent("chainingNote")
  })

  it("reports a close request to the caller", async () => {
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<ComposerCheatsheet open onOpenChange={onOpenChange} />)
    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
