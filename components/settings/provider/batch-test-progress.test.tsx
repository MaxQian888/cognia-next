/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { BatchTestProgress, TestResultsSummary } from "./batch-test-progress"

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button data-testid="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value: number }) => <div data-testid="progress" data-value={value} />,
}))

describe("BatchTestProgress", () => {
  const mockOnCancel = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns null when not running", () => {
    const { container } = render(
      <BatchTestProgress isRunning={false} progress={0} onCancel={mockOnCancel} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders progress bar when running", () => {
    render(<BatchTestProgress isRunning={true} progress={50} onCancel={mockOnCancel} />)
    expect(screen.getByTestId("progress")).toBeInTheDocument()
  })

  it("displays progress percentage", () => {
    render(<BatchTestProgress isRunning={true} progress={75} onCancel={mockOnCancel} />)
    expect(screen.getByTestId("progress")).toHaveAttribute("data-value", "75")
  })

  it("calls onCancel when cancel button clicked", () => {
    render(<BatchTestProgress isRunning={true} progress={50} onCancel={mockOnCancel} />)
    fireEvent.click(screen.getByTestId("button"))
    expect(mockOnCancel).toHaveBeenCalled()
  })

  it("disables cancel button when cancelRequested is true", () => {
    render(
      <BatchTestProgress isRunning={true} progress={50} onCancel={mockOnCancel} cancelRequested />
    )
    expect(screen.getByTestId("button")).toBeDisabled()
  })
})

describe("TestResultsSummary", () => {
  it("returns null when total is 0", () => {
    const { container } = render(<TestResultsSummary success={0} failed={0} total={0} />)
    expect(container.firstChild).toBeNull()
  })

  it("displays success count", () => {
    render(<TestResultsSummary success={5} failed={0} total={5} />)
    expect(screen.getByText(/5/)).toBeInTheDocument()
  })

  it("displays failed count when there are failures", () => {
    render(<TestResultsSummary success={3} failed={2} total={5} />)
    expect(screen.getByText(/2/)).toBeInTheDocument()
  })

  it("does not display failed section when no failures", () => {
    const { container } = render(<TestResultsSummary success={5} failed={0} total={5} />)
    const failedElements = container.querySelectorAll(".text-destructive")
    expect(failedElements.length).toBe(0)
  })
})
