/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { filterKeyLabel, GlobalSearchFilterChips } from "./global-search-filter-chips"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

describe("GlobalSearchFilterChips", () => {
  it("renders nothing without tokens", () => {
    const { container } = render(<GlobalSearchFilterChips tokens={[]} onRemove={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders one chip per token and removes on ×", async () => {
    const onRemove = jest.fn()
    const tokens = [
      { key: "from", value: "user", source: "from:me" },
      { key: "title", value: "x", source: "title:x" },
      { key: "custom", value: "v", source: "custom:v" },
    ]
    render(<GlobalSearchFilterChips tokens={tokens} onRemove={onRemove} />)
    expect(screen.getAllByTestId("global-search-filter-chip")).toHaveLength(3)
    expect(screen.getByText("filters.from: user")).toBeInTheDocument()
    expect(screen.getByText("filters.title")).toBeInTheDocument()
    expect(screen.getByText("custom: v")).toBeInTheDocument()
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: 'filters.remove:{"filter":"filters.from: user"}' }))
    expect(onRemove).toHaveBeenCalledWith(tokens[0])
  })

  it("filterKeyLabel maps known keys and passes unknown ones through", () => {
    const t = (k: string) => `T.${k}`
    expect(filterKeyLabel("in", t)).toBe("T.filters.in")
    expect(filterKeyLabel("workspace", t)).toBe("T.filters.workspace")
    expect(filterKeyLabel("zzz", t)).toBe("zzz")
  })
})
