/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { TriageSectionHeading } from "./triage-section-heading"

describe("TriageSectionHeading", () => {
  it("renders a level-3 heading with the given id", () => {
    render(<TriageSectionHeading id="drafts">Drafts</TriageSectionHeading>)
    expect(screen.getByRole("heading", { level: 3, name: "Drafts" })).toHaveAttribute(
      "id",
      "drafts"
    )
  })

  it("renders trailing content beside the heading", () => {
    render(
      <TriageSectionHeading trailing={<span data-testid="trailing">Last 30</span>}>
        Recent
      </TriageSectionHeading>
    )
    expect(screen.getByTestId("trailing")).toHaveTextContent("Last 30")
  })
})
