import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { allowlistIsLoopbackOnly, GatewayListenerPanel } from "./listener-panel"
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
    <GatewayListenerPanel
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

describe("GatewayListenerPanel", () => {
  it("lets a port below the clamp floor be typed out before committing", () => {
    // Regression: clamping per keystroke turned the first digit of "8080" into
    // 1024 (the `min`), so most ports were literally unreachable by typing.
    const { persist } = setup()
    const input = screen.getByLabelText("port")

    fireEvent.change(input, { target: { value: "8" } })
    expect(persist).not.toHaveBeenCalled()
    expect(input).toHaveValue(8)

    fireEvent.change(input, { target: { value: "8080" } })
    fireEvent.blur(input)
    expect(persist).toHaveBeenCalledWith({ port: 8080 })
  })

  it("clamps an out-of-range port only once the edit is committed", () => {
    const { persist } = setup()
    const input = screen.getByLabelText("port")

    fireEvent.change(input, { target: { value: "70000" } })
    expect(persist).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(persist).toHaveBeenCalledWith({ port: 65535 })
  })

  it("switches the bind interface and reveals the LAN warning", async () => {
    const user = userEvent.setup()
    const { persist } = setup()

    expect(screen.queryByText("lanWarning")).not.toBeInTheDocument()
    await user.click(screen.getByRole("radio", { name: "bindLan" }))
    expect(persist).toHaveBeenCalledWith({ bindInterface: "lan" })
  })

  it("does not clear the selected bind interface", async () => {
    const user = userEvent.setup()
    const { persist } = setup()

    await user.click(screen.getByRole("radio", { name: "bindLoopback" }))

    expect(persist).not.toHaveBeenCalled()
  })

  it("shows the LAN warning whenever LAN is the configured interface", () => {
    setup({ bindInterface: "lan" })
    expect(screen.getByText("lanWarning")).toBeInTheDocument()
  })

  it("keeps an allowlist chip typed but never Enter-ed instead of dropping it on blur", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("allowlist")
    fireEvent.change(input, { target: { value: "10.0.0.0/8" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({
      allowlist: expect.arrayContaining(["10.0.0.0/8"]),
    })
  })

  it("removes an allowlist chip", () => {
    const { persist } = setup()

    fireEvent.click(screen.getByRole("button", { name: "remove 127.0.0.1/32" }))

    expect(persist).toHaveBeenCalledWith({ allowlist: [] })
  })

  it("marks every bind-time field, and only those, with the restart badge", () => {
    setup()

    for (const field of ["port", "bindInterface", "allowlist", "rateLimitPerMin"]) {
      expect(screen.getByTestId(`gateway-bind-time-${field}`)).toHaveTextContent("bindTimeBadge")
    }
    // Public origin is read per request.
    expect(screen.queryByTestId("gateway-bind-time-publicOrigin")).not.toBeInTheDocument()
  })

  it("flips a field's badge to pending when Rust reports it as diverged", () => {
    setup({ port: 50001 }, ["port", "allowlist"])

    expect(screen.getByTestId("gateway-bind-time-port")).toHaveAttribute("data-pending", "true")
    expect(screen.getByTestId("gateway-bind-time-allowlist")).toHaveAttribute(
      "data-pending",
      "true"
    )
    expect(screen.getByTestId("gateway-bind-time-bindInterface")).toHaveAttribute(
      "data-pending",
      "false"
    )
  })

  it("edits the global rate limit, which is bind-time and so lives here", () => {
    const { persist } = setup()
    const input = screen.getByLabelText("rateLimit")

    fireEvent.change(input, { target: { value: "120" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({ rateLimitPerMin: 120 })
  })

  it("refuses an allowlist entry Rust would reject, with the reason inline", async () => {
    const user = userEvent.setup()
    const { persist } = setup()

    await user.type(screen.getByLabelText("allowlist"), "10.0.0.0/33{Enter}")

    expect(persist).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("allowlistInvalid")
  })

  it("warns that an empty allowlist refuses every caller", () => {
    setup({ allowlist: [] })

    expect(screen.getByTestId("gateway-allowlist-empty")).toBeInTheDocument()
  })

  it("warns when LAN binding still only admits loopback callers", () => {
    setup({ bindInterface: "lan", allowlist: ["127.0.0.1/32"] })

    expect(screen.getByTestId("gateway-lan-unreachable")).toBeInTheDocument()
  })

  it("does not warn once the allowlist admits a LAN range", () => {
    setup({ bindInterface: "lan", allowlist: ["127.0.0.1/32", "192.168.1.0/24"] })

    expect(screen.queryByTestId("gateway-lan-unreachable")).not.toBeInTheDocument()
  })

  it("rejects a malformed public origin before it reaches Rust", () => {
    const { persist } = setup()
    const input = screen.getByTestId("gateway-public-origin")

    fireEvent.change(input, { target: { value: "gateway.example.com/path" } })
    fireEvent.blur(input)

    expect(persist).not.toHaveBeenCalled()
    expect(screen.getByTestId("gateway-public-origin-error")).toBeInTheDocument()
  })
})

describe("allowlistIsLoopbackOnly", () => {
  it("is true only for a non-empty list of 127.x entries", () => {
    expect(allowlistIsLoopbackOnly(["127.0.0.1/32", "127.0.0.0/8"])).toBe(true)
    expect(allowlistIsLoopbackOnly(["127.0.0.1/32", "10.0.0.0/8"])).toBe(false)
    expect(allowlistIsLoopbackOnly([])).toBe(false)
  })
})
