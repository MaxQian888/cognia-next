/**
 * Tests for A2UIComparisonCards.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { A2UIComparisonCards } from "./a2ui-comparison-cards"
import type { A2UIComparisonCardsComponent, A2UIComponentProps } from "@/types/a2ui/schema"

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      {node}
    </NextIntlClientProvider>
  )
}

function makeProps(
  overrides: Partial<A2UIComparisonCardsComponent> = {}
): A2UIComponentProps<A2UIComparisonCardsComponent> {
  const component: A2UIComparisonCardsComponent = {
    id: "cmp-1",
    component: "ComparisonCards",
    items: overrides.items ?? [],
    title: overrides.title,
    description: overrides.description,
    emptyText: overrides.emptyText,
    itemClickAction: overrides.itemClickAction,
  }
  return {
    component,
    surfaceId: "surface-1",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(() => null),
  }
}

describe("A2UIComparisonCards", () => {
  it("renders the i18n empty state when no items are bound", () => {
    render(withIntl(<A2UIComparisonCards {...makeProps()} />))
    expect(screen.getByText(/no comparison data available/i)).toBeInTheDocument()
  })

  it("renders the provided `emptyText` override when set", () => {
    render(withIntl(<A2UIComparisonCards {...makeProps({ emptyText: "Custom empty." })} />))
    expect(screen.getByText("Custom empty.")).toBeInTheDocument()
  })

  it("renders title + description + every card item", () => {
    const props = makeProps({
      title: "Options",
      description: "Pick the best plan",
      items: [
        { id: "a", title: "Alpha", value: "92", badge: "Fast" },
        { id: "b", title: "Beta", value: "81", badge: "Stable", footer: "Recommended" },
      ],
    })
    render(withIntl(<A2UIComparisonCards {...props} />))
    expect(screen.getByText("Options")).toBeInTheDocument()
    expect(screen.getByText("Pick the best plan")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("92")).toBeInTheDocument()
    expect(screen.getByText("Fast")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Recommended")).toBeInTheDocument()
  })

  it("fires `itemClickAction` with the clicked item payload", () => {
    const props = makeProps({
      itemClickAction: "inspect_option",
      items: [{ id: "a", title: "Alpha", value: "92" }],
    })
    render(withIntl(<A2UIComparisonCards {...props} />))
    fireEvent.click(screen.getByRole("button", { name: /Alpha/i }))
    expect(props.onAction).toHaveBeenCalledWith("inspect_option", { itemId: "a", value: "92" })
  })

  it("does NOT render a button wrapper when itemClickAction is absent", () => {
    const props = makeProps({
      items: [{ id: "a", title: "Alpha", value: "92" }],
    })
    render(withIntl(<A2UIComparisonCards {...props} />))
    expect(screen.queryByRole("button", { name: /Alpha/i })).toBeNull()
  })
})
