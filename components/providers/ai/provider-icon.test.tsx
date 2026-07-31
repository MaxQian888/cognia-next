import { render, screen } from "@testing-library/react"

import { ProviderIcon } from "./provider-icon"

describe("ProviderIcon", () => {
  it("renders a branded provider asset when one is available", () => {
    render(<ProviderIcon providerId="openai" label="OpenAI" decorative={false} />)

    expect(screen.getByRole("img", { name: "OpenAI" })).toHaveAttribute(
      "src",
      "/icons/lobe/openai.svg"
    )
  })

  it("keeps the monogram fallback for custom providers", () => {
    render(<ProviderIcon providerId="private-gateway" decorative={false} />)

    expect(screen.getByRole("img", { name: "private-gateway" })).toHaveTextContent("P")
  })
})
