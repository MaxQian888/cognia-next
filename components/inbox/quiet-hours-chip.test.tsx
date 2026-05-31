/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

const mockAdapter = jest.fn()
const mockOverride = jest.fn()
const mockIsInQuietHours = jest.fn()

jest.mock("@/hooks/connectors/use-adapter-instance", () => ({
  useAdapterInstance: () => mockAdapter(),
}))
jest.mock("@/hooks/connectors/use-conversation-overrides", () => ({
  useConversationOverride: () => mockOverride(),
}))
jest.mock("@/lib/connectors/outbound-runner", () => ({
  isInQuietHours: (...args: unknown[]) => mockIsInQuietHours(...args),
}))
jest.mock("@/components/ui/tooltip")

import { QuietHoursChip } from "./quiet-hours-chip"

describe("QuietHoursChip", () => {
  beforeEach(() => {
    mockAdapter.mockReturnValue(undefined)
    mockOverride.mockReturnValue(undefined)
    mockIsInQuietHours.mockReturnValue(false)
  })

  it("renders nothing when no quiet hours are configured", () => {
    const { container } = render(<QuietHoursChip adapterId="a1" conversationKey="ck" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the adapter quiet window when set", () => {
    mockAdapter.mockReturnValue({ quietHours: { from: "22:00", to: "08:00", tz: "UTC" } })
    render(<QuietHoursChip adapterId="a1" conversationKey="ck" />)
    const chip = screen.getByTestId("quiet-hours-chip")
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveAttribute("data-active", "false")
  })

  it("marks the chip active while inside the quiet window", () => {
    mockAdapter.mockReturnValue({ quietHours: { from: "22:00", to: "08:00", tz: "UTC" } })
    mockIsInQuietHours.mockReturnValue(true)
    render(<QuietHoursChip adapterId="a1" conversationKey="ck" />)
    expect(screen.getByTestId("quiet-hours-chip")).toHaveAttribute("data-active", "true")
  })

  it("prefers the per-conversation override window over the adapter window", () => {
    mockAdapter.mockReturnValue({ quietHours: { from: "22:00", to: "08:00", tz: "UTC" } })
    mockOverride.mockReturnValue({ quietHours: { from: "01:00", to: "02:00", tz: "UTC" } })
    render(<QuietHoursChip adapterId="a1" conversationKey="ck" />)
    expect(mockIsInQuietHours).toHaveBeenCalledWith(expect.any(Number), "01:00", "02:00", "UTC")
  })
})
