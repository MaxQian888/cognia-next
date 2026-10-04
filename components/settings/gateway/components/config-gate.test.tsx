import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GatewayConfigGate } from "./config-gate"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("GatewayConfigGate", () => {
  it("renders the panel once the config is loaded", () => {
    render(
      <GatewayConfigGate state={{ kind: "ready" }} retrying={false} onRetry={jest.fn()}>
        <div data-testid="panel" />
      </GatewayConfigGate>
    )
    expect(screen.getByTestId("panel")).toBeInTheDocument()
  })

  it("holds the panel back while the config is loading", () => {
    // Showing it would present DEFAULT_GATEWAY_CONFIG as the saved values and
    // let the first edit write them over the real config.
    render(
      <GatewayConfigGate state={{ kind: "loading" }} retrying={false} onRetry={jest.fn()}>
        <div data-testid="panel" />
      </GatewayConfigGate>
    )
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("gateway-config-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("explains a failed load, names the error and retries on request", async () => {
    const onRetry = jest.fn()
    render(
      <GatewayConfigGate
        state={{ kind: "error", message: "keyring unavailable" }}
        retrying={false}
        onRetry={onRetry}
      >
        <div data-testid="panel" />
      </GatewayConfigGate>
    )
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("gateway-config-error")).toHaveTextContent("keyring unavailable")

    await userEvent.click(screen.getByTestId("gateway-config-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("locks the retry button while a retry is in flight", () => {
    render(
      <GatewayConfigGate state={{ kind: "error", message: "x" }} retrying onRetry={jest.fn()}>
        <div />
      </GatewayConfigGate>
    )
    expect(screen.getByTestId("gateway-config-retry")).toBeDisabled()
  })
})
