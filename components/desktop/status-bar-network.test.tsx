/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NetworkMeter } from "@/hooks/use-network-meter"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/components/performance/perf-sparkline", () => ({
  PerfSparkline: ({ points }: { points: readonly (number | null)[] }) => (
    <span data-testid="sparkline" data-points={points.length} />
  ),
}))

let platform: "tauri" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }))

let meter: NetworkMeter
const useNetworkMeter = jest.fn((_: { enabled: boolean }) => meter)
jest.mock("@/hooks/use-network-meter", () => ({
  useNetworkMeter: (opts: { enabled: boolean }) => useNetworkMeter(opts),
}))

const requestOpenSettings = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: { requestOpenSettings: jest.Mock }) => unknown) =>
    selector({ requestOpenSettings }),
}))

import { StatusBarNetwork } from "./status-bar-network"

function sample(latencyMs: number | null, over: Record<string, unknown> = {}) {
  return {
    ok: latencyMs != null,
    latencyMs,
    connectMs: null,
    status: 404,
    host: "api.anthropic.com",
    route: { kind: "direct" as const, reason: "off" as const },
    error: null,
    atMs: 0,
    ...over,
  }
}

function makeMeter(over: Partial<NetworkMeter> = {}): NetworkMeter {
  return {
    available: true,
    throughput: { rxBps: 1_258_291, txBps: 49_152 },
    rxHistory: [1, 2, 3],
    txHistory: [1, 2, 3],
    interfaces: [
      { name: "en0", rxBytes: 10, txBytes: 5 },
      { name: "en5", rxBytes: 1, txBytes: 1 },
    ],
    target: { kind: "provider", providerId: "anthropic", url: "https://api.anthropic.com/v1" },
    latency: sample(182),
    latencyHistory: [sample(160), sample(204), sample(182)],
    ...over,
  }
}

beforeEach(() => {
  platform = "tauri"
  meter = makeMeter()
  jest.clearAllMocks()
})

describe("StatusBarNetwork", () => {
  it("renders nothing outside the desktop shell, and never starts measuring there", () => {
    platform = "web"
    const { container } = render(<StatusBarNetwork />)
    expect(container).toBeEmptyDOMElement()
    expect(useNetworkMeter).toHaveBeenCalledWith({ enabled: false })
  })

  it("renders nothing until the first counter read lands", () => {
    meter = makeMeter({ available: false })
    const { container } = render(<StatusBarNetwork />)
    expect(container).toBeEmptyDOMElement()
    expect(useNetworkMeter).toHaveBeenCalledWith({ enabled: true })
  })

  it("shows download, upload and latency on one line", () => {
    render(<StatusBarNetwork />)
    const chip = screen.getByTestId("status-network")
    expect(chip).toHaveTextContent("1.2 MB/s")
    expect(chip).toHaveTextContent("48.0 KB/s")
    expect(screen.getByTestId("status-network-latency")).toHaveTextContent("182 ms")
    expect(chip.querySelector("[data-quality]")).toHaveAttribute("data-quality", "fair")
    expect(chip).toHaveAttribute(
      "aria-label",
      `label:${JSON.stringify({ down: "1.2 MB/s", up: "48.0 KB/s", latency: "182 ms" })}`
    )
  })

  it("shows placeholders before the first rate and the first probe", () => {
    meter = makeMeter({ throughput: null, latency: null, latencyHistory: [] })
    render(<StatusBarNetwork />)
    expect(screen.getByTestId("status-network")).toHaveTextContent("—")
    expect(screen.getByTestId("status-network-latency")).toHaveTextContent("measuring")
    expect(screen.getByTestId("status-network").querySelector("[data-quality]")).toHaveAttribute(
      "data-quality",
      "pending"
    )
  })

  it("marks an unreachable target", () => {
    meter = makeMeter({
      latency: sample(null, { error: "connection refused" }),
      latencyHistory: [sample(null, { error: "connection refused" })],
    })
    render(<StatusBarNetwork />)
    expect(screen.getByTestId("status-network-latency")).toHaveTextContent("unreachable")
    expect(screen.getByTestId("status-network").querySelector("[data-quality]")).toHaveAttribute(
      "data-quality",
      "down"
    )
  })

  it("drops the latency part when there is nothing to measure against", () => {
    meter = makeMeter({ target: null, latency: null, latencyHistory: [] })
    render(<StatusBarNetwork />)
    expect(screen.queryByTestId("status-network-latency")).toBeNull()
  })

  it("details rates, target, route, connection cost and spread in the popover", async () => {
    const user = userEvent.setup()
    meter = makeMeter({
      latency: sample(182, {
        connectMs: 640,
        route: { kind: "proxy", protocol: "http", host: "127.0.0.1", port: 7890 },
      }),
    })
    render(<StatusBarNetwork />)
    await user.click(screen.getByTestId("status-network"))

    expect(await screen.findByTestId("status-network-throughput")).toBeInTheDocument()
    expect(screen.getAllByTestId("sparkline")).toHaveLength(2)
    expect(screen.getByTestId("status-network-interfaces")).toHaveTextContent(
      `interfaces:${JSON.stringify({ names: "en0, en5" })}`
    )
    const details = screen.getByTestId("status-network-latency-details")
    expect(details).toHaveTextContent(
      `targetProvider:${JSON.stringify({ host: "api.anthropic.com", provider: "anthropic" })}`
    )
    expect(screen.getByTestId("status-network-route")).toHaveTextContent(
      `routeProxy:${JSON.stringify({ proxy: "127.0.0.1:7890" })}`
    )
    expect(details).toHaveTextContent("connect640 ms")
    const summary = screen.getByTestId("status-network-summary")
    expect(summary).toHaveTextContent("average182 ms")
    expect(summary).toHaveTextContent("best160 ms")
    expect(summary).toHaveTextContent("worst204 ms")
    expect(summary).toHaveTextContent("loss0%")

    await user.click(screen.getByTestId("status-network-settings"))
    expect(requestOpenSettings).toHaveBeenCalledWith("network")
  })

  it("names the relay target and a direct route, and surfaces the probe error", async () => {
    const user = userEvent.setup()
    meter = makeMeter({
      target: { kind: "relay", url: "https://signal.example.com/healthz" },
      latency: sample(null, { error: "timed out" }),
      latencyHistory: [sample(null, { error: "timed out" })],
    })
    render(<StatusBarNetwork />)
    await user.click(screen.getByTestId("status-network"))
    const details = await screen.findByTestId("status-network-latency-details")
    expect(details).toHaveTextContent(
      `targetRelay:${JSON.stringify({ host: "signal.example.com" })}`
    )
    expect(screen.getByTestId("status-network-route")).toHaveTextContent("routeDirect")
    expect(screen.getByTestId("status-network-error")).toHaveTextContent("timed out")
    expect(screen.getByTestId("status-network-summary")).toHaveTextContent("loss100%")
  })
})
