import { act, fireEvent, render, screen } from "@testing-library/react"

import { RELAY_STATE_LABEL_KEY, RelayCheckBlock } from "./relay-check-block"
import type { RelayProbeState } from "@/lib/signaling/relay-probe"

import type { RelaySlice } from "@/hooks/connectivity/use-remote-access"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

function slice(overrides: Partial<RelaySlice> = {}): RelaySlice {
  return {
    source: "host",
    enabled: true,
    signalingUrl: "wss://signaling.cognia.cn/signaling",
    route: "unchecked",
    // Default to the Host's own vantage; the companion case overrides it.
    probedFromHost: true,
    result: null,
    checkedAt: null,
    checking: false,
    check: jest.fn(async () => {}),
    ...overrides,
  }
}

describe("RelayCheckBlock", () => {
  it("runs the probe on demand and reports a ready relay with its lanes", async () => {
    const relay = slice({
      result: {
        state: "ready",
        healthUrl: "https://signaling.cognia.cn/healthz",
        backend: "worker",
        version: "0.1.0",
        latencyMs: 42,
        capabilities: { protocol: 2, lanes: ["signal", "data"], relayDataLane: true },
      },
      route: "ready",
      checkedAt: 1_000,
    })
    render(<RelayCheckBlock relay={relay} formatTime={() => "12:00"} />)
    expect(screen.getByTestId("relay-check-url")).toHaveTextContent("wss://signaling.cognia.cn")
    expect(screen.getByTestId("relay-check-state")).toHaveAttribute("data-state", "ready")
    expect(screen.getByTestId("relay-check-message")).toHaveTextContent("ready:42,2,worker,0.1.0")
    expect(screen.getByTestId("relay-check-lanes")).toHaveTextContent("lanes:signal, data")
    expect(screen.getByTestId("relay-check-lanes")).toHaveTextContent("lastChecked:12:00")
    await act(async () => {
      fireEvent.click(screen.getByTestId("relay-check-button"))
    })
    expect(relay.check).toHaveBeenCalled()
  })

  it("explains a legacy rendezvous and an unreachable one in words, not a status code", () => {
    const { rerender } = render(
      <RelayCheckBlock
        relay={slice({
          route: "legacy",
          result: { state: "legacy", healthUrl: "https://r/healthz", latencyMs: 30 },
        })}
      />
    )
    expect(screen.getByTestId("relay-check-message")).toHaveTextContent("legacy:30")
    rerender(
      <RelayCheckBlock
        relay={slice({
          route: "unreachable",
          result: { state: "unreachable", healthUrl: "https://r/healthz", error: "timeout" },
        })}
      />
    )
    expect(screen.getByTestId("relay-check-message")).toHaveTextContent(
      "unreachable:https://r/healthz,timeout"
    )
  })

  it("names a relay this browser origin may not read, as up but pre-CORS", () => {
    render(
      <RelayCheckBlock
        relay={slice({
          source: "local",
          route: "cors-blocked",
          result: {
            state: "cors-blocked",
            healthUrl: "https://r/healthz",
            error: "Failed to fetch",
          },
        })}
      />
    )
    expect(screen.getByTestId("relay-check-state")).toHaveAttribute("data-state", "cors-blocked")
    expect(screen.getByTestId("relay-check-message")).toHaveTextContent(
      "corsBlocked:https://r/healthz"
    )
  })

  it("flags a protocol mismatch even when the relay says ready", () => {
    render(
      <RelayCheckBlock
        relay={slice({
          route: "ready",
          result: {
            state: "ready",
            healthUrl: "https://r/healthz",
            latencyMs: 10,
            capabilities: { protocol: 3, lanes: ["signal", "data"], relayDataLane: true },
          },
        })}
      />
    )
    expect(screen.getByTestId("relay-check-message")).toHaveTextContent("legacyProtocol:10,3,2")
  })

  it("is inert with the reason when the relay is switched off", () => {
    render(<RelayCheckBlock relay={slice({ enabled: false, route: "off" })} />)
    expect(screen.getByTestId("relay-check-button")).toBeDisabled()
    expect(screen.getByTestId("relay-check-message")).toHaveTextContent("off")
    expect(screen.queryByTestId("relay-check-state")).toBeNull()
  })

  it("says which side's setting a standalone browser is reading", () => {
    render(<RelayCheckBlock relay={slice({ source: "local" })} />)
    expect(screen.getByTestId("relay-check-block")).toHaveAttribute("data-source", "local")
    expect(screen.getByText("sourceLocal")).toBeInTheDocument()
  })

  it("says so when the probe measured this device instead of the Host", () => {
    const relay = slice({
      probedFromHost: false,
      route: "unchecked",
      result: { state: "ready", healthUrl: "https://r/healthz", latencyMs: 3 },
    })
    render(<RelayCheckBlock relay={relay} />)
    expect(screen.getByTestId("relay-check-vantage")).toHaveTextContent("notFromHost")
  })

  it("names every probe state with a key, never the wire identifier", () => {
    // `t()` is stubbed to echo the key, so a missing entry would surface as
    // `undefined`. Dynamic keys are invisible to `lint:i18n`; this is the pin.
    const states: RelayProbeState[] = [
      "ready",
      "legacy",
      "not-a-relay",
      "cors-blocked",
      "unreachable",
      "invalid-url",
    ]
    for (const state of states) {
      expect(RELAY_STATE_LABEL_KEY[state]).toMatch(/^state\.[a-zA-Z]+$/)
    }
    expect(new Set(Object.values(RELAY_STATE_LABEL_KEY)).size).toBe(states.length)
  })
})
