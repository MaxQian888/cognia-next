/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { TemplatesFilterSheet } from "./templates-filter-sheet"
import type { TemplateRouteState } from "@/hooks/templates/use-template-route-state"

function route(over: Partial<TemplateRouteState> = {}): TemplateRouteState {
  return {
    definitionId: undefined,
    tab: "library",
    query: "",
    domain: "all",
    trust: "all",
    scope: "all",
    activeFilterCount: 0,
    setDefinitionId: jest.fn(),
    setTab: jest.fn(),
    setQuery: jest.fn(),
    setDomain: jest.fn(),
    setTrust: jest.fn(),
    setScope: jest.fn(),
    clearFilters: jest.fn(),
    ...over,
  }
}

function open(state: TemplateRouteState, domains: string[] = ["skill"]) {
  render(<TemplatesFilterSheet route={state} domains={domains as never} />)
  fireEvent.click(screen.getByRole("button", { name: "filters.title" }))
}

describe("TemplatesFilterSheet", () => {
  /**
   * The phone had a search box and nothing else while the desktop offered three
   * facets, so a phone could find a template by name and could not narrow the
   * catalog at all.
   */
  it("offers scope, domain and trust", () => {
    open(route())
    expect(screen.getByTestId("templates-filter-scope-all")).toBeInTheDocument()
    expect(screen.getByTestId("templates-filter-domain-skill")).toBeInTheDocument()
    expect(screen.getByTestId("templates-filter-trust-unsigned")).toBeInTheDocument()
  })

  /** A facet that can only ever empty the list is not worth offering. */
  it("lists only the domains the catalog actually holds", () => {
    open(route(), ["skill"])
    expect(screen.queryByTestId("templates-filter-domain-workflow")).toBeNull()
  })

  it("reports the chosen facet to the URL state", () => {
    const state = route()
    open(state)
    fireEvent.click(screen.getByTestId("templates-filter-scope-builtin"))
    expect(state.setScope).toHaveBeenCalledWith("builtin")
  })

  /** Clicking the active item again is Radix's clear gesture, and it reads
      naturally as "stop filtering by this". */
  it("treats deselecting as clearing that facet", () => {
    const state = route({ scope: "builtin" })
    open(state)
    fireEvent.click(screen.getByTestId("templates-filter-scope-builtin"))
    expect(state.setScope).toHaveBeenCalledWith("all")
  })

  it("shows how many facets are narrowing the list", () => {
    open(route({ activeFilterCount: 2 }))
    expect(screen.getByTestId("templates-filter-count")).toHaveTextContent("2")
  })

  it("offers a way out only while something is filtered", () => {
    const state = route({ activeFilterCount: 1 })
    open(state)
    fireEvent.click(screen.getByTestId("templates-filter-clear"))
    expect(state.clearFilters).toHaveBeenCalled()
  })

  it("hides the clear control when nothing is filtered", () => {
    open(route())
    expect(screen.queryByTestId("templates-filter-clear")).toBeNull()
  })
})
