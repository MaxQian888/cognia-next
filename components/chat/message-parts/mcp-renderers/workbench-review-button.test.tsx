import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let canOffer = true
const openEditInWorkbenchReview = jest.fn()
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => canOffer,
  openEditInWorkbenchReview: (args: unknown) => openEditInWorkbenchReview(args),
}))

import { WorkbenchReviewButton } from "./workbench-review-button"

beforeEach(() => {
  canOffer = true
  openEditInWorkbenchReview.mockClear()
})

describe("WorkbenchReviewButton", () => {
  it("renders nothing without a session", () => {
    render(<WorkbenchReviewButton absolutePath="/repo/a.ts" />)
    expect(screen.queryByTestId("mcp-open-in-review")).not.toBeInTheDocument()
  })

  it("renders nothing when the fs backend is unavailable", () => {
    canOffer = false
    render(<WorkbenchReviewButton sessionId="s1" absolutePath="/repo/a.ts" />)
    expect(screen.queryByTestId("mcp-open-in-review")).not.toBeInTheDocument()
  })

  it("routes the file into workbench review on click", () => {
    render(<WorkbenchReviewButton sessionId="s1" absolutePath="/repo/a.ts" />)
    fireEvent.click(screen.getByTestId("mcp-open-in-review"))
    expect(openEditInWorkbenchReview).toHaveBeenCalledWith({
      sessionId: "s1",
      absolutePath: "/repo/a.ts",
    })
  })
})
