/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { SubscriptionNav } from "./subscription-nav"
import { SUBSCRIPTION_NAV_GROUPS } from "../nav-config"

describe("SubscriptionNav", () => {
  it("renders a listitem per entry under its group header", () => {
    render(
      <SubscriptionNav groups={SUBSCRIPTION_NAV_GROUPS} activeId="overview" onSelect={jest.fn()} />
    )
    const total = SUBSCRIPTION_NAV_GROUPS.reduce((n, g) => n + g.items.length, 0)
    expect(screen.getAllByRole("listitem")).toHaveLength(total)
    expect(screen.getByTestId("subscription-nav-group-usageGroup")).toBeInTheDocument()
  })

  it("marks only the active entry", () => {
    render(
      <SubscriptionNav groups={SUBSCRIPTION_NAV_GROUPS} activeId="codex" onSelect={jest.fn()} />
    )
    expect(screen.getByTestId("subscription-nav-item-codex")).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByTestId("subscription-nav-item-usage")).not.toHaveAttribute("aria-current")
  })

  it("calls onSelect with the entry id", () => {
    const onSelect = jest.fn()
    render(
      <SubscriptionNav groups={SUBSCRIPTION_NAV_GROUPS} activeId="overview" onSelect={onSelect} />
    )
    fireEvent.click(screen.getByTestId("subscription-nav-item-backup"))
    expect(onSelect).toHaveBeenCalledWith("backup")
  })

  // It drives a detail pane; it is not a tablist.
  it("is a list, not a tablist", () => {
    render(
      <SubscriptionNav groups={SUBSCRIPTION_NAV_GROUPS} activeId="overview" onSelect={jest.fn()} />
    )
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
    expect(screen.getByRole("list")).toBeInTheDocument()
  })
})
