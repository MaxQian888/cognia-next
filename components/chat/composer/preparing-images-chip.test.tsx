import { render, screen } from "@testing-library/react"

import { PreparingImagesChip } from "./preparing-images-chip"

/** The visible copy — the indicator also carries the same string, sr-only. */
const label = () => screen.getByTestId("composer-preparing-images-label")

describe("PreparingImagesChip", () => {
  it("renders nothing while no image is being prepared", () => {
    const { container } = render(<PreparingImagesChip count={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names how many images are in flight", () => {
    render(<PreparingImagesChip count={1} />)
    expect(screen.getByTestId("composer-preparing-images")).toBeInTheDocument()
    expect(label()).toHaveTextContent("Preparing 1 image…")
  })

  it("pluralizes the count", () => {
    render(<PreparingImagesChip count={3} />)
    expect(label()).toHaveTextContent("Preparing 3 images…")
  })

  it("announces the wait exactly once", () => {
    render(<PreparingImagesChip count={2} />)
    // The scan indicator owns the status role; the visible copy repeats it
    // verbatim, so it is hidden from assistive tech rather than read twice.
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(screen.getByRole("status")).toHaveAccessibleName("Preparing 2 images…")
    expect(label()).toHaveAttribute("aria-hidden", "true")
  })

  it("reads as a not-yet-real attachment (dashed chip, no remove button)", () => {
    render(<PreparingImagesChip count={1} />)
    expect(screen.getByTestId("composer-preparing-images").className).toContain("border-dashed")
    expect(screen.queryByRole("button")).toBeNull()
  })
})
