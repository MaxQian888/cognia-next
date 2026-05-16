/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { VersionDiffView } from "./version-diff-view"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      from: "From",
      to: "To",
    }
    return translations[key] || key
  },
}))

// Mock UI components
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="scroll-area">
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className} data-testid="badge">
      {children}
    </span>
  ),
}))

describe("VersionDiffView", () => {
  it("renders without crashing", () => {
    render(<VersionDiffView oldContent="line 1\nline 2" newContent="line 1\nline 2" />)
    expect(screen.getByTestId("scroll-area")).toBeInTheDocument()
  })

  it("displays labels when provided", () => {
    render(
      <VersionDiffView
        oldContent="old"
        newContent="new"
        oldLabel="Version 1"
        newLabel="Version 2"
      />
    )
    expect(screen.getByText("Version 1")).toBeInTheDocument()
    expect(screen.getByText("Version 2")).toBeInTheDocument()
  })

  it("shows unchanged lines correctly", () => {
    render(<VersionDiffView oldContent="same line" newContent="same line" />)
    expect(screen.getByText("same line")).toBeInTheDocument()
  })

  it("shows added lines with + indicator", () => {
    render(
      <VersionDiffView
        oldContent="line 1"
        newContent={`line 1
line 2`}
      />
    )
    expect(screen.getByText("+")).toBeInTheDocument()
    expect(screen.getByText("line 2")).toBeInTheDocument()
  })

  it("shows removed lines with - indicator", () => {
    render(
      <VersionDiffView
        oldContent={`line 1
line 2`}
        newContent="line 1"
      />
    )
    expect(screen.getByText("-")).toBeInTheDocument()
  })

  it("displays correct stats for additions and removals", () => {
    render(
      <VersionDiffView
        oldContent={`line 1
line 2
line 3`}
        newContent={`line 1
modified
line 3
new line`}
      />
    )
    // Should show some additions and removals
    const addedStats = screen.getByText(/\+\d/)
    const removedStats = screen.getByText(/-\d/)
    expect(addedStats).toBeInTheDocument()
    expect(removedStats).toBeInTheDocument()
  })

  it("handles empty content", () => {
    render(<VersionDiffView oldContent="" newContent="new content" />)
    expect(screen.getByText("new content")).toBeInTheDocument()
  })

  it("handles multi-line content with complex changes", () => {
    const oldContent = `function hello() {
  console.log("Hello");
  return true;
}`
    const newContent = `function hello() {
  console.log("Hello, World!");
  console.log("Extra line");
  return true;
}`

    render(<VersionDiffView oldContent={oldContent} newContent={newContent} />)

    expect(screen.getByText("function hello() {")).toBeInTheDocument()
  })

  it("applies custom className", () => {
    const { container } = render(
      <VersionDiffView oldContent="old" newContent="new" className="custom-class" />
    )
    expect(container.firstChild).toHaveClass("custom-class")
  })

  describe("Responsive Layout", () => {
    it("applies monospace font to diff content", () => {
      const { container } = render(<VersionDiffView oldContent="line 1" newContent="line 2" />)
      const diffContent = container.querySelector(".font-mono.text-xs")
      expect(diffContent).toBeInTheDocument()
    })

    it("applies line number width", () => {
      render(<VersionDiffView oldContent="line 1" newContent="line 1" />)
      const lineNumberContainer = document.querySelector(".w-10")
      expect(lineNumberContainer).toBeInTheDocument()
    })

    it("applies whitespace-pre for code formatting", () => {
      render(
        <VersionDiffView
          oldContent="verylongwordthatshouldwrapproperly"
          newContent="verylongwordthatshouldwrapproperly"
        />
      )
      const contentSpan = document.querySelector(".whitespace-pre")
      expect(contentSpan).toBeInTheDocument()
    })

    it("applies horizontal overflow to code content", () => {
      render(<VersionDiffView oldContent="line 1" newContent="line 1" />)
      const contentSpan = document.querySelector(".overflow-x-auto")
      expect(contentSpan).toBeInTheDocument()
    })

    it("collapses side-by-side grid to a single column under md", () => {
      render(<VersionDiffView mode="side-by-side" oldContent="old line" newContent="new line" />)
      const grid = document.querySelector(".grid")
      expect(grid).toBeInTheDocument()
      expect(grid?.className).toContain("grid-cols-1")
      expect(grid?.className).toContain("md:grid-cols-2")
    })
  })
})
