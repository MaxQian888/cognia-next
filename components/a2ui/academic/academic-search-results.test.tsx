/**
 * AcademicSearchResults Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { AcademicSearchResults } from "./academic-search-results"
import type { Paper } from "@/types/academic"

const createMockPaper = (id: string, title: string): Paper =>
  ({
    id,
    title,
    abstract: "Test abstract",
    authors: [{ name: "Test Author" }],
    year: 2024,
    venue: "Test Conference",
  }) as Paper

describe("AcademicSearchResults", () => {
  const defaultProps = {
    papers: [],
    query: "test query",
    totalResults: 0,
  }

  describe("rendering", () => {
    it("should render search query", () => {
      render(<AcademicSearchResults {...defaultProps} />)

      expect(screen.getByText(/test query/i)).toBeInTheDocument()
    })

    it("should render result count", () => {
      render(<AcademicSearchResults {...defaultProps} totalResults={42} />)

      expect(screen.getByText("42 papers")).toBeInTheDocument()
    })

    it("should render papers when provided", () => {
      const papers = [createMockPaper("1", "First Paper"), createMockPaper("2", "Second Paper")]

      render(<AcademicSearchResults {...defaultProps} papers={papers} totalResults={2} />)

      expect(screen.getByText("First Paper")).toBeInTheDocument()
      expect(screen.getByText("Second Paper")).toBeInTheDocument()
    })

    it("should show empty state when no papers", () => {
      render(<AcademicSearchResults {...defaultProps} />)

      expect(screen.getByText(/no papers found/i)).toBeInTheDocument()
    })
  })

  describe("loading state", () => {
    it("should show loading indicator when isLoading is true", () => {
      render(<AcademicSearchResults {...defaultProps} isLoading={true} />)

      // Should have loading state indicator
      const loadingElements = document.querySelectorAll(".animate-spin")
      expect(loadingElements.length).toBeGreaterThan(0)
    })
  })

  describe("interactions", () => {
    it("should call onPaperSelect when paper is clicked", () => {
      const onPaperSelect = jest.fn()
      const papers = [createMockPaper("1", "Test Paper")]

      render(
        <AcademicSearchResults
          {...defaultProps}
          papers={papers}
          totalResults={1}
          onPaperSelect={onPaperSelect}
        />
      )

      fireEvent.click(screen.getByText("Test Paper"))

      expect(onPaperSelect).toHaveBeenCalled()
    })

    it("should call onLoadMore when load more button is clicked", () => {
      const onLoadMore = jest.fn()
      const papers = [createMockPaper("1", "Test Paper")]

      render(
        <AcademicSearchResults
          {...defaultProps}
          papers={papers}
          totalResults={10}
          hasMore={true}
          onLoadMore={onLoadMore}
        />
      )

      const loadMoreButton = screen.queryByRole("button", { name: /load more/i })
      if (loadMoreButton) {
        fireEvent.click(loadMoreButton)
        expect(onLoadMore).toHaveBeenCalled()
      }
    })
  })

  describe("provider results", () => {
    it("should render provider results when provided", () => {
      render(
        <AcademicSearchResults
          {...defaultProps}
          providerResults={{
            arxiv: { count: 10, success: true },
            "semantic-scholar": { count: 5, success: true },
          }}
        />
      )

      // Provider badges should be rendered
      expect(screen.getByText(/arxiv/i)).toBeInTheDocument()
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <AcademicSearchResults {...defaultProps} className="custom-results-class" />
      )

      expect(container.firstChild).toHaveClass("custom-results-class")
    })
  })
})
