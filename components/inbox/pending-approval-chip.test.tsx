/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

let mockCount = 0
const mockUseCount = jest.fn((_sessionId: string) => mockCount)
jest.mock("@/hooks/connectors/use-pending-approval-count", () => ({
  usePendingApprovalCount: (id: string) => mockUseCount(id),
}))

import { PendingApprovalChip } from "./pending-approval-chip"

beforeEach(() => {
  mockCount = 0
  mockUseCount.mockClear()
})

describe("PendingApprovalChip", () => {
  it("renders nothing when no approval is pending", () => {
    render(<PendingApprovalChip sessionId="s1" />)
    expect(screen.queryByTestId("pending-approval-chip")).not.toBeInTheDocument()
    expect(mockUseCount).toHaveBeenCalledWith("s1")
  })

  it("renders the singular label for one pending approval", () => {
    mockCount = 1
    render(<PendingApprovalChip sessionId="s1" />)
    const chip = screen.getByTestId("pending-approval-chip")
    expect(chip).toHaveTextContent("1 pending approval")
    expect(chip).toHaveAttribute("data-count", "1")
    expect(chip).toHaveAttribute("role", "status")
  })

  it("renders the plural label for several pending approvals", () => {
    mockCount = 3
    render(<PendingApprovalChip sessionId="s1" />)
    expect(screen.getByTestId("pending-approval-chip")).toHaveTextContent("3 pending approvals")
  })

  it("merges a user-supplied className onto the badge", () => {
    mockCount = 2
    render(<PendingApprovalChip sessionId="s1" className="extra" />)
    expect(screen.getByTestId("pending-approval-chip")).toHaveClass("extra")
  })
})
