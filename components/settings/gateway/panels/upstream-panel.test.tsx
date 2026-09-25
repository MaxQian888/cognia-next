import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"

import { groupCooldownsByProvider, GatewayUpstreamPanel } from "./upstream-panel"
import { DEFAULT_GATEWAY_CONFIG, type GatewayKeyCooldown } from "@/types/gateway"
import { gatewayResetCooldowns } from "@/lib/tauri/gateway"

jest.mock("@/lib/tauri/gateway", () => ({ gatewayResetCooldowns: jest.fn() }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const parkedKey: GatewayKeyCooldown = {
  providerId: "openai",
  keyHint: "…1234",
  untilMs: 0,
  permanent: true,
  reason: "quota",
}

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
        pendingRestartFields: [],
      }}
      cooldowns={cooldowns}
      onRefreshCooldowns={onRefreshCooldowns}
    />
  )
  return { persist, onRefreshCooldowns }
}

describe("GatewayUpstreamPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(gatewayResetCooldowns).mockResolvedValue(1)
  })

  it("disables recovery when no accounts are parked", () => {
    setup()
    expect(screen.getByRole("button", { name: "cooldownsReset" })).toBeDisabled()
  })

  it("releases all parked keys then refreshes the list without probing", async () => {
    let complete!: (count: number) => void
    jest.mocked(gatewayResetCooldowns).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const { onRefreshCooldowns } = setup([parkedKey])
    fireEvent.click(screen.getByRole("button", { name: "cooldownsReset" }))
    expect(screen.getByRole("button", { name: "cooldownsResetting" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "cooldownsRefresh" })).toBeDisabled()
    expect(onRefreshCooldowns).not.toHaveBeenCalled()
    await act(async () => complete(1))
    expect(gatewayResetCooldowns).toHaveBeenCalledWith()
    expect(onRefreshCooldowns).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("cooldownsResetSuccess:1")
  })

  it("reports recovery failure and allows retry without refreshing", async () => {
    jest.mocked(gatewayResetCooldowns).mockRejectedValueOnce(new Error("transport unavailable"))
    const { onRefreshCooldowns } = setup([parkedKey])
    fireEvent.click(screen.getByRole("button", { name: "cooldownsReset" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("cooldownsResetFailed"))
    expect(onRefreshCooldowns).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "cooldownsReset" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("cooldownsResetSuccess:1"))
  })

  it("reports a refresh failure separately after successfully resetting", async () => {
    const { onRefreshCooldowns } = setup([parkedKey])
    onRefreshCooldowns.mockRejectedValueOnce(new Error("transport unavailable"))
    fireEvent.click(screen.getByRole("button", { name: "cooldownsReset" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("cooldownsRefreshFailed"))
    expect(toast.success).toHaveBeenCalledWith("cooldownsResetSuccess:1")
  })

  it("handles a failed manual refresh and permits retry", async () => {
    const { onRefreshCooldowns } = setup()
    onRefreshCooldowns.mockRejectedValueOnce(new Error("transport unavailable"))
    fireEvent.click(screen.getByRole("button", { name: "cooldownsRefresh" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("cooldownsRefreshFailed"))
    fireEvent.click(screen.getByRole("button", { name: "cooldownsRefresh" }))
    await waitFor(() => expect(onRefreshCooldowns).toHaveBeenCalledTimes(2))
  })

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

  it("restores one provider's parked keys without touching the others", async () => {
    const { onRefreshCooldowns } = setup([
      parkedKey,
      { providerId: "groq", keyHint: "…2", untilMs: 0, permanent: true, reason: "401" },
    ])

    fireEvent.click(screen.getByRole("button", { name: "cooldownsRestoreProviderAria:groq" }))

    await waitFor(() => expect(gatewayResetCooldowns).toHaveBeenCalledWith("groq"))
    expect(onRefreshCooldowns).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("cooldownsResetSuccess:1")
  })

  it("groups parked keys by provider, since that is what a restore acts on", () => {
    setup([
      parkedKey,
      { providerId: "groq", keyHint: "…2", untilMs: 0, permanent: true, reason: "401" },
      { providerId: "openai", keyHint: "…5678", untilMs: 0, permanent: true, reason: "quota" },
    ])

    expect(screen.getByRole("region", { name: "openai" })).toHaveTextContent("…1234")
    expect(screen.getByRole("region", { name: "openai" })).toHaveTextContent("…5678")
    expect(screen.getByRole("region", { name: "groq" })).toHaveTextContent("…2")
  })

  it("refuses a field-strip exception that could never match a provider", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("fieldStripAllow")
    fireEvent.change(input, { target: { value: "service_tier" } })
    fireEvent.blur(input)

    expect(persist).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("fieldStripAllowInvalid")
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

  it("refreshes the parked list on demand", async () => {
    const { onRefreshCooldowns } = setup([])

    fireEvent.click(screen.getByTestId("gateway-cooldowns-refresh"))

    expect(onRefreshCooldowns).toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "cooldownsRefresh" })).toBeEnabled()
    )
  })

  it("renders a permanently disabled key without a countdown", () => {
    setup([
      { providerId: "openai", keyHint: "…1234", untilMs: 0, permanent: true, reason: "quota" },
    ])

    expect(screen.getByRole("region", { name: "openai" })).toHaveTextContent("…1234")
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

  it("reads a long cooldown in minutes and seconds", () => {
    jest.useFakeTimers()
    try {
      setup([
        {
          providerId: "anthropic",
          keyHint: "…7d13",
          untilMs: Date.now() + 471_000,
          permanent: false,
          reason: "529 overloaded",
        },
      ])

      expect(screen.getByTestId("gateway-cooldown-remaining")).toHaveTextContent(
        "cooldownsRecoversInMinutes:7,51"
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it("re-reads the parked list once a countdown lifts, so the row does not linger", () => {
    jest.useFakeTimers()
    try {
      const { onRefreshCooldowns } = setup([
        {
          providerId: "openai",
          keyHint: "…9999",
          untilMs: Date.now() + 1_500,
          permanent: false,
          reason: "rate limited",
        },
      ])
      expect(onRefreshCooldowns).not.toHaveBeenCalled()

      act(() => {
        jest.advanceTimersByTime(2000)
      })
      expect(onRefreshCooldowns).toHaveBeenCalledTimes(1)

      // Elapsed once, refreshed once — the stopped tick does not keep firing.
      act(() => {
        jest.advanceTimersByTime(5000)
      })
      expect(onRefreshCooldowns).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("groupCooldownsByProvider", () => {
  it("keeps providers in first-seen order and rows in input order", () => {
    const row = (providerId: string, keyHint: string): GatewayKeyCooldown => ({
      providerId,
      keyHint,
      untilMs: 0,
      permanent: true,
      reason: "",
    })

    expect(
      groupCooldownsByProvider([row("b", "1"), row("a", "2"), row("b", "3")]).map(
        ([provider, rows]) => [provider, rows.map((r) => r.keyHint)]
      )
    ).toEqual([
      ["b", ["1", "3"]],
      ["a", ["2"]],
    ])
  })
})
