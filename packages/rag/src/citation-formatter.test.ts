/**
 * Tests for Citation Formatter
 */

// Jest globals are auto-imported
import {
  formatCitations,
  formatContextWithCitations,
  generateReferenceList,
  addInlineCitations,
  getAvailableCitationStyles,
  CITATION_STYLE_INFO,
} from "./citation-formatter"
import type { RerankResult } from "./reranker"

describe("Citation Formatter", () => {
  const mockResults: RerankResult[] = [
    {
      id: "doc-1",
      content: "This is the first document content about machine learning.",
      metadata: {
        source: "journal.pdf",
        title: "Machine Learning Basics",
        author: "John Smith",
        date: "2023-05-15",
        url: "https://example.com/ml-basics",
      },
      originalScore: 0.9,
      rerankScore: 0.9,
    },
    {
      id: "doc-2",
      content: "This is the second document about neural networks.",
      metadata: {
        source: "book.pdf",
        title: "Deep Learning Guide",
        author: "Jane Doe",
        date: "2024-01-10",
      },
      originalScore: 0.8,
      rerankScore: 0.8,
    },
  ]

  describe("formatCitations", () => {
    it("should format citations in simple style", () => {
      const result = formatCitations(mockResults, { style: "simple" })

      expect(result.citations).toHaveLength(2)
      expect(result.citations[0].marker).toBe("[1]")
      expect(result.citations[1].marker).toBe("[2]")
      expect(result.referenceList).toContain("Machine Learning Basics")
    })

    it("should format citations in APA style", () => {
      const result = formatCitations(mockResults, { style: "apa" })

      expect(result.citations[0].marker).toContain("Smith")
      expect(result.citations[0].marker).toContain("2023")
      expect(result.citations[0].fullCitation).toContain("(2023)")
    })

    it("should format citations in MLA style", () => {
      const result = formatCitations(mockResults, { style: "mla" })

      expect(result.citations[0].marker).toContain("Smith")
      expect(result.citations[0].fullCitation).toContain('"Machine Learning Basics."')
    })

    it("should format citations in Chicago style", () => {
      const result = formatCitations(mockResults, { style: "chicago" })

      expect(result.citations[0].marker).toBe("[1]")
      expect(result.citations[0].fullCitation).toContain("2023")
    })

    it("should format citations in Harvard style", () => {
      const result = formatCitations(mockResults, { style: "harvard" })

      expect(result.citations[0].marker).toContain("Smith 2023")
    })

    it("should format citations in IEEE style", () => {
      const result = formatCitations(mockResults, { style: "ieee" })

      expect(result.citations[0].marker).toBe("[1]")
      expect(result.citations[0].fullCitation).toMatch(/^\[1\]/)
    })

    it("should include relevance scores when requested", () => {
      const result = formatCitations(mockResults, {
        style: "simple",
        includeRelevanceScore: true,
      })

      expect(result.citations[0].relevanceScore).toBe(0.9)
    })

    it("should include URLs when requested", () => {
      const result = formatCitations(mockResults, {
        style: "simple",
        includeUrls: true,
      })

      expect(result.citations[0].fullCitation).toContain("https://example.com")
    })

    it("should limit number of citations", () => {
      const manyResults = Array.from({ length: 20 }, (_, i) => ({
        ...mockResults[0],
        id: `doc-${i}`,
      }))

      const result = formatCitations(manyResults, { maxCitations: 5 })

      expect(result.citations).toHaveLength(5)
    })

    it("should generate footnotes when requested", () => {
      const result = formatCitations(mockResults, {
        style: "simple",
        inlineFormat: "footnote",
      })

      expect(result.footnotes).toBeDefined()
      expect(result.footnotes).toHaveLength(2)
      expect(result.footnotes![0]).toMatch(/^1\./)
    })

    it("should build context with inline citations", () => {
      const result = formatCitations(mockResults, { style: "simple" })

      expect(result.context).toContain("[1]")
      expect(result.context).toContain("[2]")
      expect(result.context).toContain("machine learning")
    })
  })

  describe("formatContextWithCitations", () => {
    it("should format context with references section", () => {
      const result = formatContextWithCitations(mockResults, { style: "simple" })

      expect(result).toContain("## Context")
      expect(result).toContain("## References")
      expect(result).toContain("[1]")
    })
  })

  describe("generateReferenceList", () => {
    it("should generate reference list in specified style", () => {
      const result = generateReferenceList(mockResults, "apa")

      expect(result).toContain("Smith")
      expect(result).toContain("Doe")
      expect(result.split("\n")).toHaveLength(2)
    })
  })

  describe("addInlineCitations", () => {
    it("should add citations to matching text", () => {
      const text = "This is the first document content about machine learning. And more text here."

      const result = addInlineCitations(text, mockResults.slice(0, 1), { style: "simple" })

      expect(result).toContain("[1]")
    })
  })

  describe("getAvailableCitationStyles", () => {
    it("should return all available styles", () => {
      const styles = getAvailableCitationStyles()

      expect(styles).toContain("simple")
      expect(styles).toContain("apa")
      expect(styles).toContain("mla")
      expect(styles).toContain("chicago")
      expect(styles).toContain("harvard")
      expect(styles).toContain("ieee")
    })
  })

  describe("CITATION_STYLE_INFO", () => {
    it("should have info for all styles", () => {
      const styles = getAvailableCitationStyles()

      for (const style of styles) {
        expect(CITATION_STYLE_INFO[style]).toBeDefined()
        expect(CITATION_STYLE_INFO[style].name).toBeTruthy()
        expect(CITATION_STYLE_INFO[style].description).toBeTruthy()
      }
    })
  })

  describe("Edge Cases", () => {
    it("should handle results without metadata", () => {
      const minimalResults: RerankResult[] = [
        {
          id: "doc-1",
          content: "Content without metadata",
          originalScore: 0.9,
          rerankScore: 0.9,
        },
      ]

      const result = formatCitations(minimalResults, { style: "apa" })

      expect(result.citations).toHaveLength(1)
      expect(result.citations[0].fullCitation).toContain("Unknown Author")
    })

    it("should handle empty results", () => {
      const result = formatCitations([], { style: "simple" })

      expect(result.citations).toHaveLength(0)
      expect(result.referenceList).toBe("")
    })

    it("should handle invalid dates", () => {
      const resultsWithBadDate: RerankResult[] = [
        {
          ...mockResults[0],
          metadata: { ...mockResults[0].metadata, date: "not-a-date" },
        },
      ]

      const result = formatCitations(resultsWithBadDate, { style: "apa" })

      expect(result.citations[0].fullCitation).toContain("not-a-date")
    })
  })
})
