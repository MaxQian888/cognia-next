import { render, screen } from "@testing-library/react"
import { TokenUsageLine } from "./token-usage-line"

describe("TokenUsageLine", () => {
  it("returns null for missing usage", () => {
    const { container } = render(<TokenUsageLine usage={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("returns null when all counts are zero", () => {
    const { container } = render(
      <TokenUsageLine usage={{ promptTokens: 0, completionTokens: 0, totalTokens: 0 }} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders compact in/out/total counts", () => {
    render(<TokenUsageLine usage={{ promptTokens: 245, completionTokens: 12, totalTokens: 257 }} />)
    expect(screen.getByTestId("token-usage-input")).toHaveTextContent("245")
    expect(screen.getByTestId("token-usage-output")).toHaveTextContent("12")
    expect(screen.getByTestId("token-usage-total")).toHaveTextContent("257")
  })

  it("formats counts >= 1000 with k suffix", () => {
    render(
      <TokenUsageLine usage={{ promptTokens: 1234, completionTokens: 12000, totalTokens: 13234 }} />
    )
    expect(screen.getByTestId("token-usage-input")).toHaveTextContent("1.23k")
    expect(screen.getByTestId("token-usage-output")).toHaveTextContent("12.0k")
    expect(screen.getByTestId("token-usage-total")).toHaveTextContent("13.2k")
  })

  it("formats counts >= 1M with M suffix", () => {
    render(
      <TokenUsageLine
        usage={{ promptTokens: 2_500_000, completionTokens: 0, totalTokens: 2_500_000 }}
      />
    )
    expect(screen.getByTestId("token-usage-input")).toHaveTextContent("2.5M")
  })

  it("derives total from in+out when totalTokens is missing", () => {
    render(<TokenUsageLine usage={{ promptTokens: 100, completionTokens: 50 }} />)
    expect(screen.getByTestId("token-usage-total")).toHaveTextContent("150")
  })
})
