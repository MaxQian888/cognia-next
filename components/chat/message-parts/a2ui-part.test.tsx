/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIPart } from "./a2ui-part"
import type { A2UIPart as A2UIPartType } from "@/lib/claude/parts-extensions"

// Mock A2UI hooks
const mockProcessMessage = jest.fn()
const mockGetSurface = jest.fn()

jest.mock("@/components/a2ui", () => ({
  A2UIInlineSurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid="a2ui-surface" data-surface-id={surfaceId}>
      A2UI Surface
    </div>
  ),
  useA2UIMessageIntegration: () => ({
    processMessage: mockProcessMessage,
    getSurface: mockGetSurface,
  }),
}))

describe("A2UIPart", () => {
  const mockPart: A2UIPartType = {
    type: "a2ui",
    surfaceId: "test-surface-1",
    content: "<a2ui>Test content</a2ui>",
    source: "codeblock",
  }

  const defaultProps = {
    part: mockPart,
    onAction: jest.fn(),
    onDataChange: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockProcessMessage.mockReturnValue("test-surface-1")
    mockGetSurface.mockReturnValue({ id: "test-surface-1", components: [] })
  })

  it("renders A2UI surface when surface exists", () => {
    render(<A2UIPart {...defaultProps} />)

    expect(screen.getByTestId("a2ui-surface")).toBeInTheDocument()
  })

  it("returns null when no surface is found", () => {
    mockGetSurface.mockReturnValue(null)

    const { container } = render(<A2UIPart {...defaultProps} />)

    expect(container.firstChild).toBeNull()
  })

  it("calls processMessage with part content", () => {
    render(<A2UIPart {...defaultProps} />)

    expect(mockProcessMessage).toHaveBeenCalledWith(mockPart.content, mockPart.surfaceId)
  })

  it("passes surfaceId to A2UIInlineSurface", () => {
    render(<A2UIPart {...defaultProps} />)

    const surface = screen.getByTestId("a2ui-surface")
    expect(surface).toHaveAttribute("data-surface-id", "test-surface-1")
  })

  it("applies custom className", () => {
    const { container } = render(<A2UIPart {...defaultProps} className="custom-class" />)

    if (container.firstChild) {
      expect(container.firstChild).toHaveClass("custom-class")
    }
  })

  it("still routes content through unified processMessage entry", () => {
    const partWithoutA2UI: A2UIPartType = {
      ...mockPart,
      content: "Regular content without A2UI",
    }

    render(<A2UIPart {...defaultProps} part={partWithoutA2UI} />)

    expect(mockProcessMessage).toHaveBeenCalledWith(
      partWithoutA2UI.content,
      partWithoutA2UI.surfaceId
    )
  })
})
