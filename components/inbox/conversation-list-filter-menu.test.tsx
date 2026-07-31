/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"

// The shared manual mock renders menu content unconditionally and fires
// `onCheckedChange` on click, so the items are reachable without Radix.
jest.mock("@/components/ui/dropdown-menu")

import {
  ConversationListFilterMenu,
  CONVERSATION_FILTER_CHIPS,
  type ConversationFilterChip,
} from "./conversation-list-filter-menu"

function renderMenu(
  active: ConversationFilterChip[] = [],
  handlers: { onToggle?: jest.Mock; onClear?: jest.Mock } = {}
) {
  const onToggle = handlers.onToggle ?? jest.fn()
  const onClear = handlers.onClear ?? jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConversationListFilterMenu active={new Set(active)} onToggle={onToggle} onClear={onClear} />
    </NextIntlClientProvider>
  )
  return { onToggle, onClear }
}

describe("ConversationListFilterMenu", () => {
  it("exposes a labelled trigger", () => {
    renderMenu()
    expect(screen.getByTestId("conversation-filter-menu")).toHaveAttribute(
      "aria-label",
      "Filter conversations"
    )
  })

  it("offers every filter chip", () => {
    renderMenu()
    for (const chip of CONVERSATION_FILTER_CHIPS) {
      expect(screen.getByTestId(`conversation-filter-${chip}`)).toBeInTheDocument()
    }
  })

  it("reflects which chips are active", () => {
    renderMenu(["unread", "snoozed"])
    expect(screen.getByTestId("conversation-filter-unread")).toBeChecked()
    expect(screen.getByTestId("conversation-filter-snoozed")).toBeChecked()
    expect(screen.getByTestId("conversation-filter-pinned")).not.toBeChecked()
  })

  it("toggles the chip that was clicked", async () => {
    const { onToggle } = renderMenu()
    await userEvent.click(screen.getByTestId("conversation-filter-pending"))
    expect(onToggle).toHaveBeenCalledWith("pending")
  })

  it("hides the count badge until something is active", () => {
    renderMenu()
    expect(screen.queryByTestId("conversation-filter-count")).not.toBeInTheDocument()
  })

  it("counts the active filters", () => {
    renderMenu(["unread", "pinned"])
    const badge = screen.getByTestId("conversation-filter-count")
    expect(badge).toHaveTextContent("2")
    expect(badge).toHaveAttribute("aria-label", "2 filters active")
  })

  it("shows the clear action only while something is active", async () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ConversationListFilterMenu active={new Set()} onToggle={jest.fn()} onClear={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.queryByTestId("conversation-filter-clear")).not.toBeInTheDocument()
    unmount()

    const { onClear } = renderMenu(["unread"])
    await userEvent.click(screen.getByTestId("conversation-filter-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  // The rail bottoms out around 123px at `listMin`, where a text label has no
  // room; the icon-only trigger still works there.
  it("collapses its label on a narrow list", () => {
    renderMenu()
    expect(screen.getByText("Filter")).toHaveClass("hidden", "@[15rem]/conversation-list:inline")
  })
})
