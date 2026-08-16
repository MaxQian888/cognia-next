/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GLOBAL_SEARCH_SCOPES } from "@/lib/global-search/types"

import { cycleScope, GlobalSearchScopeTabs, scopeForDigit } from "./global-search-scope-tabs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("GlobalSearchScopeTabs", () => {
  it("renders every scope, marks the active one, shows counts, and switches on click", async () => {
    const onChange = jest.fn()
    render(
      <GlobalSearchScopeTabs
        value="chats"
        onChange={onChange}
        counts={{ all: 12, chats: 3, people: 0 }}
      />
    )
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(GLOBAL_SEARCH_SCOPES.length)
    expect(screen.getByRole("tab", { name: /scopes.chats/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("tab", { name: /scopes.all 12/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /scopes.chats 3/ })).toBeInTheDocument()
    // Zero counts stay hidden.
    expect(screen.getByRole("tab", { name: "scopes.people" })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("tab", { name: /scopes.messages/ }))
    expect(onChange).toHaveBeenCalledWith("messages")
    expect(tabs[0]).toHaveAttribute("aria-keyshortcuts", "Alt+1")
  })

  it("cycles and maps digits", () => {
    expect(cycleScope("all", 1)).toBe("chats")
    expect(cycleScope("all", -1)).toBe("library")
    expect(cycleScope("library", 1)).toBe("all")
    expect(scopeForDigit(1)).toBe("all")
    expect(scopeForDigit(7)).toBe("library")
    expect(scopeForDigit(8)).toBeNull()
    expect(scopeForDigit(0)).toBeNull()
  })
})
