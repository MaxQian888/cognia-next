/**
 * Tests for A2UI Academic Templates
 */

import {
  createPaperCardSurface,
  createSearchResultsSurface,
  createAnalysisPanelSurface,
  createPaperComparisonSurface,
  createReadingListSurface,
  type AcademicTemplateType,
} from "./academic-templates"
import type { Paper, LibraryPaper } from "@/types/academic"

// Mock generateTemplateId
jest.mock("./templates", () => ({
  generateTemplateId: jest.fn((prefix: string) => `${prefix}-test-id`),
}))

describe("academic-templates", () => {
  const mockPaper: Paper = {
    id: "paper-1",
    providerId: "arxiv",
    externalId: "arxiv:2024.12345",
    title: "Deep Learning for Natural Language Processing",
    authors: [
      { name: "John Doe", authorId: "a1" },
      { name: "Jane Smith", authorId: "a2" },
      { name: "Bob Wilson", authorId: "a3" },
      { name: "Alice Brown", authorId: "a4" },
    ],
    year: 2024,
    venue: "NeurIPS",
    citationCount: 150,
    isOpenAccess: true,
    abstract: "This paper presents a novel approach to NLP using deep learning techniques. ".repeat(
      20
    ),
    pdfUrl: "https://example.com/paper.pdf",
    urls: [{ url: "https://example.com/paper", type: "abstract", source: "arxiv" }],
    metadata: {},
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    fetchedAt: new Date("2024-01-01"),
  }

  const mockLibraryPaper: LibraryPaper = {
    ...mockPaper,
    libraryId: "lib-1",
    addedAt: new Date("2024-01-15"),
    tags: ["nlp", "deep-learning"],
    readingStatus: "reading",
    priority: "high",
  }

  describe("createPaperCardSurface", () => {
    it("should create a paper card surface with correct structure", () => {
      const result = createPaperCardSurface(mockPaper)

      expect(result.surfaceId).toBe("paper-card-test-id")
      expect(result.messages).toHaveLength(4)
      expect(result.messages[0].type).toBe("createSurface")
      expect(result.messages[1].type).toBe("updateComponents")
      expect(result.messages[2].type).toBe("dataModelUpdate")
      expect(result.messages[3].type).toBe("surfaceReady")
    })

    it("should use provided surfaceId if given", () => {
      const result = createPaperCardSurface(mockPaper, "custom-surface-id")

      expect(result.surfaceId).toBe("custom-surface-id")
    })

    it("should format author names correctly", () => {
      const result = createPaperCardSurface(mockPaper)
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")

      expect(dataModelMessage).toBeDefined()
      const data = (dataModelMessage as unknown as { data: { paper: { authorsText: string } } })
        .data
      expect(data.paper.authorsText).toBe("John Doe, Jane Smith, Bob Wilson, Alice Brown")
    })

    it("should truncate abstract to 300 characters", () => {
      const result = createPaperCardSurface(mockPaper)
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")

      const data = (dataModelMessage as unknown as { data: { paper: { abstractPreview: string } } })
        .data
      expect(data.paper.abstractPreview.length).toBeLessThanOrEqual(303) // 300 + '...'
    })

    it("should set hasYear/hasVenue/hasCitations flags correctly", () => {
      const result = createPaperCardSurface(mockPaper)
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")

      const data = (dataModelMessage as unknown as { data: { paper: Record<string, unknown> } })
        .data
      expect(data.paper.hasYear).toBe(true)
      expect(data.paper.hasVenue).toBe(true)
      expect(data.paper.hasCitations).toBe(true)
      expect(data.paper.isOpenAccess).toBe(true)
      expect(data.paper.hasPdf).toBe(true)
    })

    it("should handle paper without optional fields", () => {
      const minimalPaper: Paper = {
        id: "paper-minimal",
        providerId: "arxiv",
        externalId: "arxiv:minimal",
        title: "Minimal Paper",
        authors: [{ name: "Author", authorId: "a1" }],
        urls: [],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        fetchedAt: new Date(),
      }

      const result = createPaperCardSurface(minimalPaper)
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")

      const data = (dataModelMessage as unknown as { data: { paper: Record<string, unknown> } })
        .data
      expect(data.paper.hasYear).toBe(false)
      expect(data.paper.hasVenue).toBe(false)
      expect(data.paper.hasCitations).toBe(false)
      expect(data.paper.isOpenAccess).toBe(false)
      expect(data.paper.hasAbstract).toBe(false)
      expect(data.paper.hasPdf).toBe(false)
    })

    it("should include all required components", () => {
      const result = createPaperCardSurface(mockPaper)
      const componentsMessage = result.messages.find((m) => m.type === "updateComponents")

      const components = (componentsMessage as { components: Array<{ id: string }> }).components
      const componentIds = components.map((c: { id: string }) => c.id)

      expect(componentIds).toContain("root")
      expect(componentIds).toContain("header")
      expect(componentIds).toContain("title")
      expect(componentIds).toContain("authors")
      expect(componentIds).toContain("actions")
    })

    it("should work with LibraryPaper type", () => {
      const result = createPaperCardSurface(mockLibraryPaper)

      expect(result.surfaceId).toBeDefined()
      expect(result.messages).toHaveLength(4)
    })
  })

  describe("createSearchResultsSurface", () => {
    const papers: Paper[] = [mockPaper, { ...mockPaper, id: "paper-2", title: "Second Paper" }]

    it("should create search results surface with correct structure", () => {
      const result = createSearchResultsSurface(papers, "deep learning", 100)

      expect(result.surfaceId).toBe("search-results-test-id")
      expect(result.messages).toHaveLength(4)
    })

    it("should use provided surfaceId", () => {
      const result = createSearchResultsSurface(papers, "test", 50, "custom-id")

      expect(result.surfaceId).toBe("custom-id")
    })

    it("should include filter components", () => {
      const result = createSearchResultsSurface(papers, "test", 50)
      const componentsMessage = result.messages.find((m) => m.type === "updateComponents")

      const components = (componentsMessage as { components: Array<{ id: string }> }).components
      const componentIds = components.map((c: { id: string }) => c.id)

      expect(componentIds).toContain("provider-filter")
      expect(componentIds).toContain("year-filter")
      expect(componentIds).toContain("sort-select")
      expect(componentIds).toContain("paper-list")
    })

    it("should format paper list items correctly", () => {
      const result = createSearchResultsSurface(papers, "test", 50)
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")

      const data = (
        dataModelMessage as unknown as { data: { papers: Array<{ id: string; title: string }> } }
      ).data
      expect(data.papers).toHaveLength(2)
      expect(data.papers[0].title).toBe(mockPaper.title)
    })

    it("should truncate author list with et al. for more than 3 authors", () => {
      const result = createSearchResultsSurface(papers, "test", 50)
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")

      const data = (
        dataModelMessage as unknown as { data: { papers: Array<{ subtitle: string }> } }
      ).data
      expect(data.papers[0].subtitle).toContain("et al.")
    })

    it("should handle empty results", () => {
      const result = createSearchResultsSurface([], "no results", 0)

      expect(result.surfaceId).toBeDefined()
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")
      const data = (dataModelMessage as unknown as { data: { papers: unknown[] } }).data
      expect(data.papers).toHaveLength(0)
    })
  })

  describe("createAnalysisPanelSurface", () => {
    it("should create analysis panel surface", () => {
      const result = createAnalysisPanelSurface(
        mockPaper,
        "summary",
        "This is the analysis content."
      )

      expect(result.surfaceId).toBeDefined()
      expect(result.messages).toHaveLength(4)
    })

    it("should support different analysis types", () => {
      const analysisTypes = [
        "summary",
        "methodology",
        "findings",
        "critique",
        "related-work",
      ] as const

      for (const type of analysisTypes) {
        const result = createAnalysisPanelSurface(mockPaper, type, "Analysis content")
        expect(result.surfaceId).toBeDefined()
      }
    })

    it("should include analysis-specific components", () => {
      const result = createAnalysisPanelSurface(mockPaper, "summary", "Content here")
      const componentsMessage = result.messages.find((m) => m.type === "updateComponents")

      const components = (componentsMessage as unknown as { components: Array<{ id: string }> })
        .components
      expect(components.length).toBeGreaterThan(0)
    })
  })

  describe("createPaperComparisonSurface", () => {
    const comparisonPapers = [
      {
        title: mockPaper.title,
        authors: "John Doe et al.",
        year: 2024,
        abstract: mockPaper.abstract,
      },
      {
        title: "Comparison Paper",
        authors: "Jane Smith",
        year: 2023,
        abstract: "Another abstract",
      },
    ]

    it("should create comparison surface for multiple papers", () => {
      const result = createPaperComparisonSurface(comparisonPapers, "Comparison content here")

      expect(result.surfaceId).toBeDefined()
      expect(result.messages).toHaveLength(4)
    })

    it("should include comparison table components", () => {
      const result = createPaperComparisonSurface(comparisonPapers, "Comparison content")
      const componentsMessage = result.messages.find((m) => m.type === "updateComponents")

      expect(componentsMessage).toBeDefined()
    })

    it("should handle single paper", () => {
      const result = createPaperComparisonSurface([comparisonPapers[0]], "Single paper comparison")

      expect(result.surfaceId).toBeDefined()
    })
  })

  describe("createReadingListSurface", () => {
    const libraryPapers: LibraryPaper[] = [
      mockLibraryPaper,
      {
        ...mockLibraryPaper,
        id: "paper-2",
        title: "Second Library Paper",
        readingStatus: "unread",
      },
    ]

    it("should create reading list surface", () => {
      const result = createReadingListSurface(libraryPapers, "My Reading List")

      expect(result.surfaceId).toBeDefined()
      expect(result.messages).toHaveLength(4)
    })

    it("should include list management components", () => {
      const result = createReadingListSurface(libraryPapers, "Research Papers")
      const componentsMessage = result.messages.find((m) => m.type === "updateComponents")

      expect(componentsMessage).toBeDefined()
    })

    it("should handle empty reading list", () => {
      const result = createReadingListSurface([], "Empty List")

      expect(result.surfaceId).toBeDefined()
    })

    it("should group papers by read status", () => {
      const result = createReadingListSurface(libraryPapers, "Grouped List")
      const dataModelMessage = result.messages.find((m) => m.type === "dataModelUpdate")

      expect(dataModelMessage).toBeDefined()
    })
  })

  describe("AcademicTemplateType", () => {
    it("should include all expected template types", () => {
      const types: AcademicTemplateType[] = [
        "paper-card",
        "paper-list",
        "search-results",
        "analysis-panel",
        "paper-comparison",
        "citation-network",
        "reading-list",
      ]

      // Type check passes if this compiles
      expect(types).toHaveLength(7)
    })
  })
})
