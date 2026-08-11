import { act, fireEvent, render, screen } from "@testing-library/react"

import { GatewayUpstreamPanel } from "./upstream-panel"
import { DEFAULT_GATEWAY_CONFIG, type GatewayKeyCooldown } from "@/types/gateway"

// Echo interpolation values too: a countdown test that asserts only the key
// passes no matter which number was interpolated.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

function setup(cooldowns: GatewayKeyCooldown[] = []) {
  const persist = jest.fn().mockResolvedValue(undefined)
  const onRefreshCooldowns = jest.fn().mockResolvedValue(undefined)
  render(
    <GatewayUpstreamPanel
      ctx={{
        config: DEFAULT_GATEWAY_CONFIG,
        status: null,
        persist,
        replace: jest.fn(),
        restartRequired: false,
      }}
      cooldowns={cooldowns}
      onRefreshCooldowns={onRefreshCooldowns}
    />
  )
  return { persist, onRefreshCooldowns }
}

describe("GatewayUpstreamPanel", () => {
  it.each([
    ["maxConcurrentPerKey", "4", { maxConcurrentPerKey: 4 }],
    ["maxConcurrentPerUpstreamKey", "6", { maxConcurrentPerUpstreamKey: 6 }],
    ["concurrencyWait", "2500", { concurrencyWaitMs: 2500 }],
    ["streamIdleTimeout", "90", { streamIdleTimeoutSecs: 90 }],
    ["cooldownFallback", "0", { cooldownFallbackSecs: 0 }],
    ["overloadCooldown", "90", { overloadCooldownSecs: 90 }],
  ])("persists the %s number field", (label, typed, expected) => {
    const { persist } = setup()

    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith(expected)
  })

  it("accepts 0 for the stream idle timeout as the documented wait-forever opt-out", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("streamIdleTimeout")
    fireEvent.change(input, { target: { value: "0" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({ streamIdleTimeoutSecs: 0 })
  })

  it.each([
    ["disableKeywords", "billing_hard_limit_reached", "disableKeywords"],
    ["strippedFields", "metadata.user_id", "strippedRequestFields"],
    ["fieldStripAllow", "openai:store", "fieldStripAllow"],
  ])("appends to the %s chip list", (label, typed, configKey) => {
    const { persist } = setup()

    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ [configKey]: expect.arrayContaining([typed]) })
    )
  })

  it("shows the empty state with no parked keys", () => {
    setup([])
    expect(screen.getByText("cooldownsEmpty")).toBeInTheDocument()
  })

  it("refreshes the parked list on demand", () => {
    const { onRefreshCooldowns } = setup([])

    fireEvent.click(screen.getByTestId("gateway-cooldowns-refresh"))

    expect(onRefreshCooldowns).toHaveBeenCalled()
  })

  it("renders a permanently disabled key without a countdown", () => {
    setup([
      { providerId: "openai", keyHint: "…1234", untilMs: 0, permanent: true, reason: "quota" },
    ])

    expect(screen.getByText(/openai · …1234/)).toBeInTheDocument()
    expect(screen.getByText("cooldownsPermanent")).toBeInTheDocument()
    expect(screen.queryByTestId("gateway-cooldown-remaining")).not.toBeInTheDocument()
  })

  it("renders the cooldown reason, which used to be dropped on the floor", () => {
    setup([
      {
        providerId: "openai",
        keyHint: "…9999",
        untilMs: Date.now() + 30_000,
        permanent: false,
        reason: "429 rate limited",
      },
    ])

    expect(screen.getByTestId("gateway-cooldown-reason-openai")).toHaveTextContent(
      "429 rate limited"
    )
  })

  it("counts a temporary cooldown down and flips to recovered", () => {
    jest.useFakeTimers()
    try {
      setup([
        {
          providerId: "openai",
          keyHint: "…9999",
          untilMs: Date.now() + 3_000,
          permanent: false,
          reason: "rate limited",
        },
      ])

      // Assert the interpolated number, not just the key — the row is useless
      // if it counts down the wrong field.
      expect(screen.getByTestId("gateway-cooldown-remaining")).toHaveTextContent(
        "cooldownsRecoversIn:3"
      )

      act(() => {
        jest.advanceTimersByTime(2000)
      })
      expect(screen.getByTestId("gateway-cooldown-remaining")).toHaveTextContent(
        "cooldownsRecoversIn:1"
      )

      act(() => {
        jest.advanceTimersByTime(2000)
      })
      expect(screen.getByTestId("gateway-cooldown-recovered")).toBeInTheDocument()
      expect(screen.queryByTestId("gateway-cooldown-remaining")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })
})
