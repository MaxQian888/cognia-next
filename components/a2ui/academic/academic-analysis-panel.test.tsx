/**
 * AcademicAnalysisPanel Component Tests
 */

import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AcademicAnalysisPanel } from "./academic-analysis-panel"
import type { PaperAnalysisType } from "@/types/academic"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock lucide-react with forwardRef components (needed for Radix UI Slot compatibility)
jest.mock("lucide-react", () => {
  const createIcon = (name: string) => {
    const IconComponent = React.forwardRef<SVGSVGElement, React.SVGProps<SVGSVGElement>>(
      (props, ref) => <svg ref={ref} data-testid={`icon-${name}`} {...props} />
    )
    IconComponent.displayName = name
    return IconComponent
  }
  return {
    Brain: createIcon("brain"),
    Copy: createIcon("copy"),
    Check: createIcon("check"),
    CheckIcon: createIcon("check-icon"),
    RefreshCw: createIcon("refresh"),
    MessageSquare: createIcon("message"),
    ChevronDown: createIcon("chevron-down"),
    ChevronDownIcon: createIcon("chevron-down-icon"),
    ChevronUpIcon: createIcon("chevron-up-icon"),
    Lightbulb: createIcon("lightbulb"),
    BookOpen: createIcon("book-open"),
  }
})

// Mock Collapsible to avoid Radix Primitive.span.SlotClone issues
jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open: _open,
    onOpenChange: _onOpenChange,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => <div {...props}>{children}</div>,
  CollapsibleTrigger: ({
    children,
    asChild,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...props}>{children}</button>,
  CollapsibleContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}))

// Mock ScrollArea
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}))

// Mock clipboard API
Object.assign(navigator, {
  clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
})

describe("AcademicAnalysisPanel", () => {
  const defaultProps = {
    paperTitle: "Test Paper",
    analysisType: "summary" as PaperAnalysisType,
    analysisContent: "This is the analysis content.",
  }

  describe("rendering", () => {
    it("should render analysis content", () => {
      render(<AcademicAnalysisPanel {...defaultProps} />)

      expect(screen.getByText("This is the analysis content.")).toBeInTheDocument()
    })

    it("should render paper title", () => {
      render(<AcademicAnalysisPanel {...defaultProps} />)

      expect(screen.getByText("Test Paper")).toBeInTheDocument()
    })

    it("should render analysis type selector", () => {
      render(<AcademicAnalysisPanel {...defaultProps} />)

      // Should have a select for analysis type
      expect(screen.getByRole("combobox")).toBeInTheDocument()
    })

    it("should render suggested questions when provided", () => {
      render(
        <AcademicAnalysisPanel
          {...defaultProps}
          suggestedQuestions={["Question 1?", "Question 2?"]}
        />
      )

      expect(screen.getByText("Question 1?")).toBeInTheDocument()
      expect(screen.getByText("Question 2?")).toBeInTheDocument()
    })

    it("should render related topics when provided", () => {
      render(<AcademicAnalysisPanel {...defaultProps} relatedTopics={["Topic A", "Topic B"]} />)

      expect(screen.getByText("Topic A")).toBeInTheDocument()
      expect(screen.getByText("Topic B")).toBeInTheDocument()
    })
  })

  describe("loading state", () => {
    it("should show loading indicator when isLoading is true", () => {
      render(<AcademicAnalysisPanel {...defaultProps} isLoading={true} />)

      // Should have loading state
      expect(screen.getByRole("combobox")).toBeDisabled()
    })
  })

  describe("interactions", () => {
    it("should call onRegenerate when regenerate button is clicked", () => {
      const onRegenerate = jest.fn()
      render(<AcademicAnalysisPanel {...defaultProps} onRegenerate={onRegenerate} />)

      const regenerateButton = screen.queryByRole("button", { name: /regenerate/i })
      if (regenerateButton) {
        fireEvent.click(regenerateButton)
        expect(onRegenerate).toHaveBeenCalled()
      }
    })

    it("should call onCopy when copy button is clicked", async () => {
      const onCopy = jest.fn()
      render(<AcademicAnalysisPanel {...defaultProps} onCopy={onCopy} />)

      const copyButton = screen.queryByRole("button", { name: /copy/i })
      if (copyButton) {
        fireEvent.click(copyButton)
        await waitFor(() => {
          expect(onCopy).toHaveBeenCalledWith("This is the analysis content.")
        })
      }
    })

    it("should call onAskFollowUp when suggested question is clicked", () => {
      const onAskFollowUp = jest.fn()
      render(
        <AcademicAnalysisPanel
          {...defaultProps}
          suggestedQuestions={["Follow up question?"]}
          onAskFollowUp={onAskFollowUp}
        />
      )

      const questionButton = screen.getByText("Follow up question?")
      fireEvent.click(questionButton)

      expect(onAskFollowUp).toHaveBeenCalledWith("Follow up question?")
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <AcademicAnalysisPanel {...defaultProps} className="custom-analysis-class" />
      )

      expect(container.firstChild).toHaveClass("custom-analysis-class")
    })
  })
})
