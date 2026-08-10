import { render, screen } from "@testing-library/react"
import { PluginMarketplaceSkeleton } from "./plugin-marketplace-skeleton"

describe("PluginMarketplaceSkeleton", () => {
  it("renders the requested number of card placeholders", () => {
    const { container } = render(<PluginMarketplaceSkeleton count={4} />)
    expect(container.querySelectorAll("[data-slot='card']")).toHaveLength(4)
    expect(container.querySelectorAll("[data-slot='card-header']")).toHaveLength(4)
    expect(container.querySelectorAll("[data-slot='card-content']")).toHaveLength(4)
    expect(container.querySelectorAll("[data-slot='card-footer']")).toHaveLength(4)
  })

  it("defaults to 6 placeholders + tags the wrapper as aria-busy", () => {
    const { container } = render(<PluginMarketplaceSkeleton />)
    expect(container.querySelectorAll("[data-slot='card']")).toHaveLength(6)
    const wrapper = screen.getByTestId("plugin-marketplace-skeleton")
    expect(wrapper.getAttribute("aria-busy")).toBe("true")
  })
})
