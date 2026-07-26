import { render, screen } from "@testing-library/react"
import { OgCard } from "./og-card"

describe("OgCard", () => {
  it("renders the eyebrow, title and origin", () => {
    render(
      <OgCard
        eyebrow="Trust"
        title="Every claim, and where to check it."
        locale="en"
        origin="cognia.example"
      />
    )
    expect(screen.getByText("Trust")).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "Every claim, and where to check it." })
    ).toBeInTheDocument()
    expect(screen.getByText("cognia.example")).toBeInTheDocument()
  })

  it("is exactly the share-image size, so the capture needs no cropping", () => {
    render(<OgCard eyebrow="Trust" title="Title" locale="en" origin="cognia.example" />)
    const card = screen.getByTestId("og-card")
    expect(card).toHaveClass("w-[1200px]")
    expect(card).toHaveClass("h-[630px]")
  })

  it("declares the card's language so the right typeface metrics apply", () => {
    render(<OgCard eyebrow="信任" title="标题" locale="zh" origin="cognia.example" />)
    expect(screen.getByTestId("og-card")).toHaveAttribute("lang", "zh-Hans")
  })

  it("uses the site's own tokens rather than hard-coded colours", () => {
    render(<OgCard eyebrow="Trust" title="Title" locale="en" origin="cognia.example" />)
    expect(screen.getByTestId("og-card")).toHaveClass("bg-paper")
  })

  it("keeps the decorative rule out of the accessibility tree", () => {
    const { container } = render(
      <OgCard eyebrow="Trust" title="Title" locale="en" origin="cognia.example" />
    )
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
  })
})
