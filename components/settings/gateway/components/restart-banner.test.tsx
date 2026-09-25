import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GATEWAY_BIND_TIME_FIELDS } from "@/types/gateway"

import { BIND_TIME_FIELD_NAME_KEYS, GatewayRestartBanner } from "./restart-banner"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
  useFormatter: () => ({ list: (items: string[]) => items.join(" & ") }),
}))

describe("GatewayRestartBanner", () => {
  it("renders nothing while no bind-time edit is pending", () => {
    render(<GatewayRestartBanner pending={[]} restarting={false} onRestart={jest.fn()} />)

    expect(screen.queryByTestId("gateway-restart-banner")).not.toBeInTheDocument()
  })

  it("names every pending field as a noun fit for the sentence", () => {
    render(
      <GatewayRestartBanner
        pending={["port", "connectTimeoutSecs"]}
        restarting={false}
        onRestart={jest.fn()}
      />
    )

    const banner = screen.getByTestId("gateway-restart-banner")
    expect(banner).toHaveTextContent("restartBannerTitle:2")
    expect(banner).toHaveTextContent(
      "restartBannerFields:bindTimeFieldNames.port & bindTimeFieldNames.connectTimeoutSecs"
    )
  })

  it("restarts on click and locks the button while a restart is in flight", async () => {
    const onRestart = jest.fn()
    const { rerender } = render(
      <GatewayRestartBanner pending={["allowlist"]} restarting={false} onRestart={onRestart} />
    )

    await userEvent.click(screen.getByTestId("gateway-restart-listener"))
    expect(onRestart).toHaveBeenCalledTimes(1)

    rerender(<GatewayRestartBanner pending={["allowlist"]} restarting onRestart={onRestart} />)
    expect(screen.getByTestId("gateway-restart-listener")).toBeDisabled()
  })

  it("has a name for every bind-time field Rust can report", () => {
    for (const field of GATEWAY_BIND_TIME_FIELDS) {
      expect(BIND_TIME_FIELD_NAME_KEYS[field]).toBeTruthy()
    }
  })
})
