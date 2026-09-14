/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { TaskTagsDisplay } from "./task-tags-display"

describe("TaskTagsDisplay", () => {
  it("renders each tag chip", () => {
    render(<TaskTagsDisplay tags={["alpha", "beta"]} />)
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("renders an empty-state line when no tags are present", () => {
    render(<TaskTagsDisplay tags={[]} />)
    // Translation mock returns the English value or the key.
    expect(screen.getByText(/No tags|noTags/)).toBeInTheDocument()
  })

  it("forwards className to the wrapping Card", () => {
    const { container } = render(<TaskTagsDisplay tags={["alpha"]} className="extra-class" />)
    expect(container.querySelector(".extra-class")).not.toBeNull()
  })

  it("renders only the badges in the bare variant, for a host that owns the title", () => {
    render(<TaskTagsDisplay tags={["alpha"]} variant="bare" />)
    expect(screen.getByTestId("task-tags-badges")).toBeInTheDocument()
    expect(screen.queryByRole("heading")).not.toBeInTheDocument()
    expect(screen.getByText("alpha")).toBeInTheDocument()
  })
})
