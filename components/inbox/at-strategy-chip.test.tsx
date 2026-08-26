/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

const mockAdapter = jest.fn()
const mockOverride = jest.fn()
jest.mock("@/hooks/connectors/use-adapter-instance", () => ({
  useAdapterInstance: () => mockAdapter(),
}))
jest.mock("@/hooks/connectors/use-conversation-overrides", () => ({
  useConversationOverride: () => mockOverride(),
}))
jest.mock("@/components/ui/tooltip")

import { AtStrategyChip } from "./at-strategy-chip"

describe("AtStrategyChip", () => {
  beforeEach(() => {
    mockAdapter.mockReturnValue(undefined)
    mockOverride.mockReturnValue(undefined)
  })

  it("renders nothing until the bot row is readable", () => {
    const { container } = render(<AtStrategyChip adapterId="a1" />)
    expect(container).toBeEmptyDOMElement()
  })

  /**
   * The regression this fixes: the settings UI writes `inboundActivationPolicy`,
   * and the chip read `atResponseStrategy`, so it was blank for every adapter
   * configured through the current forms.
   */
  it("reports the policy the settings UI actually writes", () => {
    mockAdapter.mockReturnValue({ inboundActivationPolicy: "always" })
    render(<AtStrategyChip adapterId="a1" />)
    expect(screen.getByTestId("at-strategy-chip")).toHaveTextContent("Every message")
  })

  it("still reads a legacy row through the same resolver as the bus", () => {
    mockAdapter.mockReturnValue({ atResponseStrategy: "direct_only" })
    render(<AtStrategyChip adapterId="a1" />)
    expect(screen.getByTestId("at-strategy-chip")).toHaveAttribute("data-policy", "direct_only")
  })

  // An unset row admits on `mention_each`, which is a restriction worth naming
  // — the old chip hid exactly here and showed only for the loosened settings.
  it("names the default instead of hiding it", () => {
    mockAdapter.mockReturnValue({})
    render(<AtStrategyChip adapterId="a1" />)
    expect(screen.getByTestId("at-strategy-chip")).toHaveTextContent("@mention each time")
  })

  it("lets the conversation override outrank the bot, and says so", () => {
    mockAdapter.mockReturnValue({ inboundActivationPolicy: "mention_each" })
    mockOverride.mockReturnValue({ inboundActivationPolicy: "always" })
    render(<AtStrategyChip adapterId="a1" conversationKey="telegram:a1:c1" />)
    expect(screen.getByTestId("at-strategy-chip")).toHaveAttribute("data-policy", "always")
    expect(screen.getByText(/This conversation overrides the bot/)).toBeInTheDocument()
  })

  it("attributes an inherited policy to the bot", () => {
    mockAdapter.mockReturnValue({ inboundActivationPolicy: "mention_activates" })
    render(<AtStrategyChip adapterId="a1" conversationKey="telegram:a1:c1" />)
    expect(screen.getByText(/This bot answers in a group when/)).toBeInTheDocument()
  })
})
