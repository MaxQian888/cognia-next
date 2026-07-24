import { fireEvent, render, screen } from "@testing-library/react"
import { AttachmentTextCard } from "./attachment-text-card"

describe("AttachmentTextCard", () => {
  it("shows the filename and extracted length without the body", () => {
    render(<AttachmentTextCard filename="report.pdf" mediaType="application/pdf" text="abcde" />)
    expect(screen.getByText("report.pdf")).toBeInTheDocument()
    expect(screen.getByText("5 chars extracted")).toBeInTheDocument()
    // Collapsed by default — the point of the bubble is the user's own message.
    expect(screen.queryByTestId("attachment-text-card-body")).not.toBeInTheDocument()
  })

  it("uses the singular form for a one-character extraction", () => {
    render(<AttachmentTextCard filename="a.txt" text="x" />)
    expect(screen.getByText("1 char extracted")).toBeInTheDocument()
  })

  it("expands and collapses the extracted text", () => {
    render(<AttachmentTextCard filename="report.pdf" text="the full body text" />)
    const toggle = screen.getByRole("button", { name: /report\.pdf/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("attachment-text-card-body")).toHaveTextContent("the full body text")

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("attachment-text-card-body")).not.toBeInTheDocument()
  })

  it("wires the toggle to the body for assistive tech", () => {
    render(<AttachmentTextCard filename="a.txt" text="body" />)
    const toggle = screen.getByRole("button", { name: /a\.txt/ })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-controls")).toBe(
      screen.getByTestId("attachment-text-card-body").id
    )
  })

  it("puts the media type in the title without cluttering the label", () => {
    render(<AttachmentTextCard filename="a.csv" mediaType="text/csv" text="x,y" />)
    expect(screen.getByTitle("a.csv · text/csv")).toBeInTheDocument()
  })

  it("renders a card for an empty extraction rather than crashing", () => {
    render(<AttachmentTextCard filename="empty.txt" text="" />)
    expect(screen.getByText("0 chars extracted")).toBeInTheDocument()
  })
})
