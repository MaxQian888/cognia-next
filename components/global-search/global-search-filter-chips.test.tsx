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

describe("workspace scope chip", () => {
  it("says which workspace a plain search is confined to", () => {
    // A default the user cannot see is indistinguishable from a search that is
    // simply missing things.
    render(
      <GlobalSearchFilterChips
        tokens={[]}
        onRemove={() => {}}
        workspaceScope={{ name: "Cognia", onWiden: () => {} }}
      />
    )
    expect(screen.getByTestId("global-search-workspace-scope")).toHaveTextContent("Cognia")
  })

  it("widens the search on click", async () => {
    const onWiden = jest.fn()
    render(
      <GlobalSearchFilterChips
        tokens={[]}
        onRemove={() => {}}
        workspaceScope={{ name: "Cognia", onWiden }}
      />
    )
    await userEvent.click(screen.getByTestId("global-search-workspace-scope"))
    expect(onWiden).toHaveBeenCalledTimes(1)
  })

  it("renders nothing at all when there is neither a token nor a scope", () => {
    const { container } = render(<GlobalSearchFilterChips tokens={[]} onRemove={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the scope chip beside ordinary filter chips", () => {
    render(
      <GlobalSearchFilterChips
        tokens={[{ key: "from", value: "user", source: "from:me" }]}
        onRemove={() => {}}
        workspaceScope={{ name: "Cognia", onWiden: () => {} }}
      />
    )
    expect(screen.getByTestId("global-search-workspace-scope")).toBeInTheDocument()
    expect(screen.getAllByTestId("global-search-filter-chip")).toHaveLength(1)
  })
})
