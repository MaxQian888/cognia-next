/**
 * A2UI Analysis Adapter Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIAnalysisAdapter } from "./a2ui-analysis-adapter"
import type { A2UIComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock AcademicAnalysisPanel
jest.mock("./academic-analysis-panel", () => ({
  AcademicAnalysisPanel: ({
    paperTitle,
    analysisType,
    analysisContent,
    isLoading,
    onAnalysisTypeChange,
    onRegenerate,
    onAskFollowUp,
    onCopy,
  }: {
    paperTitle: string
    analysisType: string
    analysisContent: string
    isLoading: boolean
    onAnalysisTypeChange: (type: string) => void
    onRegenerate: () => void
    onAskFollowUp: (q: string) => void
    onCopy: (c: string) => void
  }) => (
    <div data-testid="analysis-panel">
      <span data-testid="paper-title">{paperTitle}</span>
      <span data-testid="analysis-type">{analysisType}</span>
      <span data-testid="analysis-content">{analysisContent}</span>
      {isLoading && <span data-testid="loading">Loading...</span>}
      <button onClick={() => onAnalysisTypeChange("critique")}>Change Type</button>
      <button onClick={() => onRegenerate()}>Regenerate</button>
      <button onClick={() => onAskFollowUp("test question")}>Ask</button>
      <button onClick={() => onCopy("copy text")}>Copy</button>
    </div>
  ),
}))

describe("A2UIAnalysisAdapter", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (dataModel: Record<string, unknown> = {}): A2UIComponentProps => ({
    component: { id: "analysis-1", component: "AcademicAnalysis" } as A2UIComponent,
    surfaceId: "test-surface",
    dataModel,
    onAction: mockOnAction,
    onDataChange: mockOnDataChange,
    renderChild: mockRenderChild,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render analysis panel with data from dataModel", () => {
    render(
      <A2UIAnalysisAdapter
        {...createProps({
          paperTitle: "Test Paper",
          analysisType: "summary",
          analysisContent: "This paper discusses...",
        })}
      />
    )

    expect(screen.getByTestId("paper-title")).toHaveTextContent("Test Paper")
    expect(screen.getByTestId("analysis-type")).toHaveTextContent("summary")
    expect(screen.getByTestId("analysis-content")).toHaveTextContent("This paper discusses...")
  })

  it("should use default values when dataModel is empty", () => {
    render(<A2UIAnalysisAdapter {...createProps()} />)

    expect(screen.getByTestId("paper-title")).toHaveTextContent("")
    expect(screen.getByTestId("analysis-type")).toHaveTextContent("summary")
    expect(screen.getByTestId("analysis-content")).toHaveTextContent("")
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument()
  })

  it("should show loading state from dataModel", () => {
    render(<A2UIAnalysisAdapter {...createProps({ isLoading: true })} />)

    expect(screen.getByTestId("loading")).toBeInTheDocument()
  })

  it("should call onDataChange and onAction when analysis type changes", () => {
    render(<A2UIAnalysisAdapter {...createProps()} />)

    fireEvent.click(screen.getByText("Change Type"))

    expect(mockOnDataChange).toHaveBeenCalledWith("analysisType", "critique")
    expect(mockOnAction).toHaveBeenCalledWith("analysisTypeChange", { type: "critique" })
  })

  it("should call onAction on regenerate", () => {
    render(<A2UIAnalysisAdapter {...createProps()} />)

    fireEvent.click(screen.getByText("Regenerate"))

    expect(mockOnAction).toHaveBeenCalledWith("regenerate", {})
  })

  it("should call onAction on ask follow-up", () => {
    render(<A2UIAnalysisAdapter {...createProps()} />)

    fireEvent.click(screen.getByText("Ask"))

    expect(mockOnAction).toHaveBeenCalledWith("askFollowUp", { question: "test question" })
  })

  it("should call onAction on copy", () => {
    render(<A2UIAnalysisAdapter {...createProps()} />)

    fireEvent.click(screen.getByText("Copy"))

    expect(mockOnAction).toHaveBeenCalledWith("copy", { content: "copy text" })
  })
})
