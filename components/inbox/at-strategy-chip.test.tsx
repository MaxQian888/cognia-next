/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

const mockAdapter = jest.fn()
jest.mock("@/hooks/connectors/use-adapter-instance", () => ({
  useAdapterInstance: () => mockAdapter(),
}))
jest.mock("@/components/ui/tooltip")

import { AtStrategyChip } from "./at-strategy-chip"

describe("AtStrategyChip", () => {
  beforeEach(() => mockAdapter.mockReturnValue(undefined))

  it("renders nothing when no strategy is set", () => {
    const { container } = render(<AtStrategyChip adapterId="a1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing for the default 'always' strategy", () => {
    mockAdapter.mockReturnValue({ atResponseStrategy: "always" })
    const { container } = render(<AtStrategyChip adapterId="a1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the chip for the mention_only strategy", () => {
    mockAdapter.mockReturnValue({ atResponseStrategy: "mention_only" })
    render(<AtStrategyChip adapterId="a1" />)
    const chip = screen.getByTestId("at-strategy-chip")
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveTextContent("@mention only")
  })

  it("renders the chip for the direct_only strategy", () => {
    mockAdapter.mockReturnValue({ atResponseStrategy: "direct_only" })
    render(<AtStrategyChip adapterId="a1" />)
    expect(screen.getByTestId("at-strategy-chip")).toHaveTextContent("Direct only")
  })
})
