/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { ReviewPanel } from "./review-panel"
import creatorMessages from "@/i18n/messages/en/creator.json"
import type { CreatorReviewVerdict } from "@/types/creator"

function renderPanel(verdict: CreatorReviewVerdict | null) {
  render(
    <NextIntlClientProvider locale="en" messages={{ creator: creatorMessages }}>
      <ReviewPanel verdict={verdict} />
    </NextIntlClientProvider>
  )
}

const approved: CreatorReviewVerdict = {
  approved: true,
  findings: [],
  reviewerAuthority: "plan",
}

describe("ReviewPanel", () => {
  it("says the review has not run yet", () => {
    renderPanel(null)
    expect(screen.getByText(creatorMessages.review.pending)).toBeInTheDocument()
  })

  it("always states that the reviewer is read-only with its own context", () => {
    renderPanel(null)
    expect(screen.getByText(creatorMessages.review.readOnly)).toBeInTheDocument()
  })

  it("shows an approval", () => {
    renderPanel(approved)
    expect(screen.getByRole("status")).toHaveTextContent(creatorMessages.review.approved)
    expect(screen.getByText(creatorMessages.review.noFindings)).toBeInTheDocument()
  })

  it("shows a rejection", () => {
    renderPanel({
      approved: false,
      reviewerAuthority: "plan",
      findings: [{ id: "f1", severity: "blocker", summary: "escapes the authoring root" }],
    })
    expect(screen.getByRole("status")).toHaveTextContent(creatorMessages.review.rejected)
    expect(screen.getByText("escapes the authoring root")).toBeInTheDocument()
    expect(screen.getByText(creatorMessages.review.severity.blocker)).toBeInTheDocument()
  })

  // Surfacing the authority is how an accidental widening becomes visible
  // rather than staying a property nobody checks.
  it("displays the reviewer's own resolved authority", () => {
    renderPanel(approved)
    expect(screen.getByText(/Reviewer permission: plan/)).toBeInTheDocument()
  })

  it("renders a file-scoped finding with its path", () => {
    renderPanel({
      approved: false,
      reviewerAuthority: "plan",
      findings: [{ id: "f2", severity: "warning", summary: "no test", path: "src/index.ts" }],
    })
    expect(screen.getByText("src/index.ts")).toBeInTheDocument()
    expect(screen.getByText(creatorMessages.review.severity.warning)).toBeInTheDocument()
  })

  it("renders an info finding", () => {
    renderPanel({
      approved: true,
      reviewerAuthority: "plan",
      findings: [{ id: "f3", severity: "info", summary: "consider a README" }],
    })
    expect(screen.getByText(creatorMessages.review.severity.info)).toBeInTheDocument()
  })
})
