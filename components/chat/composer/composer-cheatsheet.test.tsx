/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ComposerCheatsheet, shortcutRows } from "./composer-cheatsheet"
import { useSettingsStore } from "@/stores/settings"

afterEach(() => {
  useSettingsStore.setState({ settings: null } as never)
})

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
      "keys.stop",
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

  it("documents the send keys the user's setting actually uses", () => {
    useSettingsStore.setState({
      settings: { composerBehavior: { sendOnEnter: false, inputHistoryRecall: false } },
    } as never)
    render(<ComposerCheatsheet open onOpenChange={jest.fn()} />)
    const sheet = screen.getByTestId("composer-cheatsheet")
    // History recall is off, so it is not offered as a shortcut.
    expect(sheet).not.toHaveTextContent("keys.history")
    const caps = screen.getAllByText((_, el) => el?.tagName === "KBD").map((el) => el.textContent)
    expect(caps).not.toContain("⇧⏎")
    expect(caps.some((cap) => cap === "⌘" || cap === "Ctrl")).toBe(true)
  })
})

describe("shortcutRows", () => {
  it("follows Send on Enter and the history switch", () => {
    const on = shortcutRows({ sendOnEnter: true, historyRecall: true, appleGlyphs: true })
    expect(on.find((row) => row.key === "send")?.combo).toEqual(["⏎"])
    expect(on.find((row) => row.key === "newline")?.combo).toEqual(["⇧", "⏎"])
    expect(on.some((row) => row.key === "history")).toBe(true)

    const off = shortcutRows({ sendOnEnter: false, historyRecall: false, appleGlyphs: false })
    expect(off.find((row) => row.key === "send")?.combo).toEqual(["Ctrl", "⏎"])
    expect(off.find((row) => row.key === "newline")?.combo).toEqual(["⏎"])
    expect(off.some((row) => row.key === "history")).toBe(false)
  })
})
