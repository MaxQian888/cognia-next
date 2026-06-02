import { render, screen } from "@testing-library/react"
import { PetBubbleView } from "./pet-bubble"

describe("PetBubbleView", () => {
  it("renders nothing when there is no bubble", () => {
    const { container } = render(<PetBubbleView bubble={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the text and origin", () => {
    render(<PetBubbleView bubble={{ text: "Mrrp!", origin: "llm" }} />)
    const el = screen.getByRole("status")
    expect(el).toHaveTextContent("Mrrp!")
    expect(el).toHaveAttribute("data-bubble-origin", "llm")
  })
})
