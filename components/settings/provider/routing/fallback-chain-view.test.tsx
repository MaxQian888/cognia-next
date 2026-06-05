import { render, screen } from "@testing-library/react"
import { FallbackChainView } from "./fallback-chain-view"

describe("FallbackChainView", () => {
  it("renders every entry as provider:model with the first highlighted", () => {
    render(
      <FallbackChainView
        entries={[
          { providerId: "groq", modelId: "llama" },
          { providerId: "openai", modelId: "gpt-4o-mini", weight: 2 },
        ]}
      />
    )
    expect(screen.getByText("groq:llama")).toBeInTheDocument()
    // Weighted entries show their weight.
    expect(screen.getByText("openai:gpt-4o-mini ×2")).toBeInTheDocument()
  })

  it("renders nothing for an empty chain", () => {
    const { container } = render(<FallbackChainView entries={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
