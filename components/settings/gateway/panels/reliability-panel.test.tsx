import { fireEvent, render, screen } from "@testing-library/react"

import { GatewayReliabilityPanel, isValidRetryStatus } from "./reliability-panel"
import {
  DEFAULT_GATEWAY_CONFIG,
  type GatewayBindTimeField,
  type GatewayConfig,
} from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

function setup(config: Partial<GatewayConfig> = {}, pending: GatewayBindTimeField[] = []) {
  const persist = jest.fn().mockResolvedValue(undefined)
  render(
    <GatewayReliabilityPanel
      ctx={{
        config: { ...DEFAULT_GATEWAY_CONFIG, ...config },
        status: null,
        persist,
        replace: jest.fn(),
        pendingRestartFields: pending,
      }}
    />
  )
  return { persist }
}

describe("GatewayReliabilityPanel", () => {
  // Beyond coverage this pins the label → config-key wiring, which is the
  // obvious copy-paste hazard in a panel of near-identical number rows.
  it.each([
    ["connectTimeout", "15", { connectTimeoutSecs: 15 }],
    ["requestTimeout", "0", { requestTimeoutSecs: 0 }],
    ["maxRetries", "3", { maxRetries: 3 }],
    ["retryBackoffBase", "400", { retryBackoffBaseMs: 400 }],
    ["retryBackoffMax", "5000", { retryBackoffMaxMs: 5000 }],
    ["maxRetryWait", "45000", { maxRetryWaitMs: 45000 }],
  ])("persists the %s number field", (label, typed, expected) => {
    const { persist } = setup()

    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith(expected)
  })

  it("no longer hosts the global rate limit, which is bind-time and lives on Listener", () => {
    setup()
    expect(screen.queryByLabelText("rateLimit")).not.toBeInTheDocument()
  })

  it("commits a number field on Enter without waiting for blur", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("maxRetries")
    fireEvent.change(input, { target: { value: "3" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(persist).toHaveBeenCalledWith({ maxRetries: 3 })
  })

  it("keeps the backoff base from exceeding the max, which Rust would refuse", () => {
    const { persist } = setup({ retryBackoffBaseMs: 250, retryBackoffMaxMs: 4000 })

    const input = screen.getByLabelText("retryBackoffBase")
    fireEvent.change(input, { target: { value: "9000" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({ retryBackoffBaseMs: 4000 })
  })

  it("keeps the backoff max from dropping below the base", () => {
    const { persist } = setup({ retryBackoffBaseMs: 250, retryBackoffMaxMs: 4000 })

    const input = screen.getByLabelText("retryBackoffMax")
    fireEvent.change(input, { target: { value: "100" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({ retryBackoffMaxMs: 250 })
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

  it("refuses a status outside the HTTP range with a reason, instead of dropping it", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("retryStatusCodes")
    fireEvent.change(input, { target: { value: "99" } })
    fireEvent.blur(input)

    expect(persist).not.toHaveBeenCalled()
    expect(input).toHaveValue("99")
    expect(screen.getByRole("alert")).toHaveTextContent("retryStatusCodesInvalid")
  })

  it("marks the connect timeout as bind-time and flips it when Rust reports it pending", () => {
    setup({}, ["connectTimeoutSecs"])

    expect(screen.getByTestId("gateway-bind-time-connectTimeoutSecs")).toHaveAttribute(
      "data-pending",
      "true"
    )
    // The request timeout is read per request.
    expect(screen.queryByTestId("gateway-bind-time-requestTimeoutSecs")).not.toBeInTheDocument()
  })

  it("labels only the live sections as applying without a restart", () => {
    setup()
    expect(screen.getAllByText("liveBadge")).toHaveLength(2)
  })

  it("persists retry-header and local-routing switches", () => {
    const { persist } = setup()

    fireEvent.click(screen.getByRole("switch", { name: "respectRetryAfter" }))
    fireEvent.click(screen.getByRole("switch", { name: "gatewayLocalRoutingV2" }))

    expect(persist).toHaveBeenCalledWith({ respectRetryAfter: false })
    expect(persist).toHaveBeenCalledWith({ gatewayLocalRoutingV2: false })
  })
})

describe("isValidRetryStatus", () => {
  it.each(["100", "429", "599"])("accepts %s", (value) =>
    expect(isValidRetryStatus(value)).toBe(true)
  )

  it.each(["99", "600", "42x", "4290", "", "5e2"])("rejects %s", (value) =>
    expect(isValidRetryStatus(value)).toBe(false)
  )
})
