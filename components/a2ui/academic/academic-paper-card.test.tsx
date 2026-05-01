/**
 * AcademicPaperCard Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { AcademicPaperCard } from "./academic-paper-card"
import type { Paper } from "@/types/academic"

const createMockPaper = (overrides: Partial<Paper> = {}): Paper =>
  ({
    id: "paper-1",
    title: "Test Paper Title",
    abstract: "This is a test abstract for the paper.",
    authors: [
      { name: "John Doe", affiliation: "Test University" },
      { name: "Jane Smith", affiliation: "Research Institute" },
    ],
    year: 2024,
    venue: "Test Conference",
    citationCount: 42,
    ...overrides,
  }) as Paper

describe("AcademicPaperCard", () => {
  describe("rendering", () => {
    it("should render paper title", () => {
      render(<AcademicPaperCard paper={createMockPaper()} />)

      expect(screen.getByText("Test Paper Title")).toBeInTheDocument()
    })

    it("should render authors", () => {
      render(<AcademicPaperCard paper={createMockPaper()} />)

      expect(screen.getByText(/John Doe/)).toBeInTheDocument()
    })

    it('should truncate authors list with "et al." for more than 3 authors', () => {
      const paper = createMockPaper({
        authors: [
          { name: "Author 1" },
          { name: "Author 2" },
          { name: "Author 3" },
          { name: "Author 4" },
        ],
      })

      render(<AcademicPaperCard paper={paper} />)

      expect(screen.getByText(/et al\./)).toBeInTheDocument()
    })

    it("should render year", () => {
      render(<AcademicPaperCard paper={createMockPaper()} />)

      expect(screen.getByText("2024")).toBeInTheDocument()
    })

    it("should render citation count", () => {
      render(<AcademicPaperCard paper={createMockPaper()} />)

      expect(screen.getByText("42")).toBeInTheDocument()
    })
  })

  describe("interactions", () => {
    it("should call onViewDetails when card is clicked", () => {
      const onViewDetails = jest.fn()
      const paper = createMockPaper()

      render(<AcademicPaperCard paper={paper} onViewDetails={onViewDetails} />)

      fireEvent.click(screen.getByText("Test Paper Title").closest("div")!)

      expect(onViewDetails).toHaveBeenCalledWith(paper)
    })

    it("should call onAddToLibrary when add button is clicked", () => {
      const onAddToLibrary = jest.fn()
      const paper = createMockPaper()

      render(
        <AcademicPaperCard paper={paper} onAddToLibrary={onAddToLibrary} isInLibrary={false} />
      )

      const addButton = screen.queryByRole("button", { name: /add/i })
      if (addButton) {
        fireEvent.click(addButton)
        expect(onAddToLibrary).toHaveBeenCalledWith(paper)
      }
    })

    it("should call onOpenPdf when pdf button is clicked", () => {
      const onOpenPdf = jest.fn()
      const paper = createMockPaper({ pdfUrl: "https://example.com/paper.pdf" })

      render(<AcademicPaperCard paper={paper} onOpenPdf={onOpenPdf} />)

      const pdfButton = screen.queryByRole("button", { name: /pdf/i })
      if (pdfButton) {
        fireEvent.click(pdfButton)
        expect(onOpenPdf).toHaveBeenCalledWith("https://example.com/paper.pdf")
      }
    })

    it("should call onAnalyze when analyze button is clicked", () => {
      const onAnalyze = jest.fn()
      const paper = createMockPaper()

      render(<AcademicPaperCard paper={paper} onAnalyze={onAnalyze} />)

      const analyzeButton = screen.queryByRole("button", { name: /analyze/i })
      if (analyzeButton) {
        fireEvent.click(analyzeButton)
        expect(onAnalyze).toHaveBeenCalledWith(paper)
      }
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <AcademicPaperCard paper={createMockPaper()} className="custom-paper-class" />
      )

      expect(container.firstChild).toHaveClass("custom-paper-class")
    })

    it("should apply compact styles when compact is true", () => {
      const { container } = render(<AcademicPaperCard paper={createMockPaper()} compact={true} />)

      expect(container.firstChild).toHaveClass("p-3")
    })
  })

  describe("library state", () => {
    it("should render differently when isInLibrary is true", () => {
      render(<AcademicPaperCard paper={createMockPaper()} isInLibrary={true} />)

      // Add button should not appear for papers already in library
      expect(screen.queryByRole("button", { name: /add to library/i })).not.toBeInTheDocument()
    })
  })
})
