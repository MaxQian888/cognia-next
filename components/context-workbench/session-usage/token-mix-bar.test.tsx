/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { TokenMixBar } from "./token-mix-bar"

describe("TokenMixBar", () => {
  it("draws each token class with its count and share", () => {
    render(
      <TokenMixBar
        mix={{
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 8500,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        }}
      />
    )
    expect(screen.getByTestId("token-mix-input")).toHaveTextContent("1.0K10%")
    expect(screen.getByTestId("token-mix-cacheRead")).toHaveTextContent("8.5K85%")
    expect(screen.getByTestId("token-mix-cacheWrite")).toHaveTextContent("00%")
    const segments = screen.getByRole("img").querySelectorAll("[data-segment]")
    // A class with no tokens draws no slice.
    expect([...segments].map((s) => s.getAttribute("data-segment"))).toEqual([
      "input",
      "output",
      "cacheRead",
    ])
    expect(screen.queryByTestId("token-mix-reasoning")).toBeNull()
  })

  it("notes reasoning as part of output rather than a fifth slice", () => {
    render(
      <TokenMixBar
        mix={{
          inputTokens: 10,
          outputTokens: 400,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 100,
        }}
      />
    )
    expect(screen.getByTestId("token-mix-reasoning")).toHaveTextContent(
      "100 of the output was reasoning (25%)."
    )
  })

  it("explains an empty mix", () => {
    render(
      <TokenMixBar
        mix={{
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        }}
      />
    )
    expect(screen.getByTestId("token-mix-empty")).toBeInTheDocument()
  })
})
