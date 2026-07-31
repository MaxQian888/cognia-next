import { fireEvent, render, screen } from "@testing-library/react"

import { GatewayReliabilityPanel } from "./reliability-panel"
import { DEFAULT_GATEWAY_CONFIG } from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

function setup() {
  const persist = jest.fn().mockResolvedValue(undefined)
  render(
    <GatewayReliabilityPanel ctx={{ config: DEFAULT_GATEWAY_CONFIG, status: null, persist }} />
  )
  return { persist }
}

describe("GatewayReliabilityPanel", () => {
  // Beyond coverage this pins the label → config-key wiring, which is the
  // obvious copy-paste hazard in a panel of near-identical number rows.
  it.each([
    ["rateLimit", "120", { rateLimitPerMin: 120 }],
    ["connectTimeout", "15", { connectTimeoutSecs: 15 }],
    ["requestTimeout", "0", { requestTimeoutSecs: 0 }],
    ["maxRetries", "3", { maxRetries: 3 }],
  ])("persists the %s number field", (label, typed, expected) => {
    const { persist } = setup()

    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith(expected)
  })

  it("commits a number field on Enter without waiting for blur", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("maxRetries")
    fireEvent.change(input, { target: { value: "3" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(persist).toHaveBeenCalledWith({ maxRetries: 3 })
  })

  it("appends a retry status code as a number, not a string", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("retryStatusCodes")
    fireEvent.change(input, { target: { value: "418" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({
      retryStatusCodes: expect.arrayContaining([418]),
    })
  })

  it("drops a retry status code outside the HTTP range", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("retryStatusCodes")
    fireEvent.change(input, { target: { value: "99" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({
      retryStatusCodes: expect.not.arrayContaining([99]),
    })
  })

  it("marks itself as applying without a restart", () => {
    setup()
    expect(screen.getByText("liveBadge")).toBeInTheDocument()
  })
})
