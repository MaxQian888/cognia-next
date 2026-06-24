/**
 * A2UI Search Results Adapter Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UISearchResultsAdapter } from "./a2ui-search-results-adapter"
import type { A2UIComponent, A2UIComponentProps } from "@/types/a2ui/schema"
import type { Paper } from "@/types/academic"

// Mock AcademicSearchResults so the test stays focused on the adapter's
// dataModel→props mapping and action forwarding.
jest.mock("./academic-search-results", () => ({
  AcademicSearchResults: ({
    papers,
    query,
    totalResults,
    isLoading,
    hasMore,
    onPaperSelect,
    onAddToLibrary,
    onAnalyzePaper,
    onLoadMore,
    onFilterChange,
  }: {
    papers: Array<{ id: string }>
    query: string
    totalResults: number
    isLoading: boolean
    hasMore: boolean
    onPaperSelect: (p: { id: string }) => void
    onAddToLibrary: (p: { id: string }) => void
    onAnalyzePaper: (p: { id: string }) => void
    onLoadMore: () => void
    onFilterChange: (f: unknown) => void
  }) => (
    <div data-testid="search-results">
      <span data-testid="query">{query}</span>
      <span data-testid="total">{totalResults}</span>
      <span data-testid="count">{papers.length}</span>
      {isLoading && <span data-testid="loading" />}
      {hasMore && <span data-testid="has-more" />}
      <button onClick={() => onPaperSelect({ id: "p1" })}>Select</button>
      <button onClick={() => onAddToLibrary({ id: "p1" })}>Add</button>
      <button onClick={() => onAnalyzePaper({ id: "p1" })}>Analyze</button>
      <button onClick={() => onLoadMore()}>More</button>
      <button onClick={() => onFilterChange({ sortBy: "date" })}>Filter</button>
    </div>
  ),
}))

const paper = (id: string): Paper => ({ id, title: id }) as unknown as Paper

describe("A2UISearchResultsAdapter", () => {
  const onAction = jest.fn()
  const onDataChange = jest.fn()

  const props = (dataModel: Record<string, unknown> = {}): A2UIComponentProps => ({
    component: { id: "sr-1", component: "AcademicSearchResults" } as A2UIComponent,
    surfaceId: "surface",
    dataModel,
    onAction,
    onDataChange,
    renderChild: jest.fn(() => null),
  })

  beforeEach(() => jest.clearAllMocks())

  it("maps papers / query / totals from the data model", () => {
    render(
      <A2UISearchResultsAdapter
        {...props({
          papers: [paper("a"), paper("b")],
          query: "graph neural nets",
          totalResults: 7,
        })}
      />
    )
    expect(screen.getByTestId("query")).toHaveTextContent("graph neural nets")
    expect(screen.getByTestId("total")).toHaveTextContent("7")
    expect(screen.getByTestId("count")).toHaveTextContent("2")
  })

  it("defaults totalResults to the paper count and flags from the data model", () => {
    render(
      <A2UISearchResultsAdapter
        {...props({ papers: [paper("a")], isLoading: true, hasMore: true })}
      />
    )
    expect(screen.getByTestId("total")).toHaveTextContent("1")
    expect(screen.getByTestId("loading")).toBeInTheDocument()
    expect(screen.getByTestId("has-more")).toBeInTheDocument()
  })

  it("renders empty safely when the data model is empty", () => {
    render(<A2UISearchResultsAdapter {...props()} />)
    expect(screen.getByTestId("count")).toHaveTextContent("0")
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument()
  })

  it("forwards paper interactions as A2UI actions", () => {
    render(<A2UISearchResultsAdapter {...props({ papers: [paper("a")] })} />)
    fireEvent.click(screen.getByText("Select"))
    expect(onAction).toHaveBeenCalledWith("paperSelect", { id: "p1" })
    fireEvent.click(screen.getByText("Add"))
    expect(onAction).toHaveBeenCalledWith("addToLibrary", { id: "p1" })
    fireEvent.click(screen.getByText("Analyze"))
    expect(onAction).toHaveBeenCalledWith("analyzePaper", { id: "p1" })
    fireEvent.click(screen.getByText("More"))
    expect(onAction).toHaveBeenCalledWith("loadMore", {})
  })

  it("forwards filter changes to onDataChange and onAction", () => {
    render(<A2UISearchResultsAdapter {...props()} />)
    fireEvent.click(screen.getByText("Filter"))
    expect(onDataChange).toHaveBeenCalledWith("filters", { sortBy: "date" })
    expect(onAction).toHaveBeenCalledWith("filterChange", { sortBy: "date" })
  })
})
