import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { GatewayListenerPanel } from "./listener-panel"
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig, type GatewayStatus } from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const mockStart = jest.fn()
const mockStop = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayStart: () => mockStart(),
  gatewayStop: () => mockStop(),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const status = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  running: false,
  boundPort: null,
  hasToken: true,
  bindInterface: "loopback",
  callsTotal: 0,
  lastCallAt: null,
  snapshotGeneratedAtMs: null,
  snapshotProviderCount: 0,
  snapshotAliasCount: 0,
  ...over,
})

function setup(config: Partial<GatewayConfig> = {}, statusOver?: GatewayStatus | null) {
  const persist = jest.fn().mockResolvedValue(undefined)
  const onRestarted = jest.fn().mockResolvedValue(undefined)
  render(
    <GatewayListenerPanel
      ctx={{
        config: { ...DEFAULT_GATEWAY_CONFIG, ...config },
        status: statusOver === undefined ? status() : statusOver,
        persist,
      }}
      onRestarted={onRestarted}
    />
  )
  return { persist, onRestarted }
}

beforeEach(() => {
  mockStart.mockReset().mockResolvedValue(undefined)
  mockStop.mockReset().mockResolvedValue(undefined)
})

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
    const { persist } = setup()

    expect(screen.queryByText("lanWarning")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "bindLan" }))
    expect(persist).toHaveBeenCalledWith({ bindInterface: "lan" })
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

  it("stays quiet about restarting while the listener is stopped", () => {
    setup({ port: 50001 }, status({ running: false }))
    expect(screen.queryByTestId("gateway-restart-required")).not.toBeInTheDocument()
  })

  it("flags a restart when the configured port diverges from the bound one", () => {
    // The whole point of the bind-time/live split: editing the port on a
    // running listener previously looked like it had taken effect.
    setup({ port: 50001 }, status({ running: true, boundPort: 47823 }))

    expect(screen.getByTestId("gateway-restart-required")).toBeInTheDocument()
    expect(screen.getByTestId("gateway-restart-listener")).toBeInTheDocument()
  })

  it("flags a restart when the configured interface diverges", () => {
    setup(
      { bindInterface: "lan" },
      status({ running: true, boundPort: 47823, bindInterface: "loopback" })
    )

    expect(screen.getByTestId("gateway-restart-required")).toBeInTheDocument()
  })

  it("flags a restart after the allowlist is edited on a running listener", () => {
    // The allowlist has no mirror on GatewayStatus, so divergence cannot be
    // derived — it is tracked from the edit instead.
    setup({}, status({ running: true, boundPort: 47823 }))
    expect(screen.queryByTestId("gateway-restart-required")).not.toBeInTheDocument()

    const input = screen.getByLabelText("allowlist")
    fireEvent.change(input, { target: { value: "10.0.0.0/8" } })
    fireEvent.blur(input)

    expect(screen.getByTestId("gateway-restart-required")).toBeInTheDocument()
  })

  it("restarts by stopping then starting, and reports back", async () => {
    const { onRestarted } = setup({ port: 50001 }, status({ running: true, boundPort: 47823 }))

    fireEvent.click(screen.getByTestId("gateway-restart-listener"))

    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    expect(mockStop).toHaveBeenCalled()
    expect(onRestarted).toHaveBeenCalled()
  })

  it("surfaces a failed restart rather than clearing the banner", async () => {
    const { toast } = jest.requireMock("sonner")
    mockStart.mockRejectedValue(new Error("address already in use"))
    setup({ port: 50001 }, status({ running: true, boundPort: 47823 }))

    fireEvent.click(screen.getByTestId("gateway-restart-listener"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("address already in use"))
    expect(screen.getByTestId("gateway-restart-required")).toBeInTheDocument()
  })
})
