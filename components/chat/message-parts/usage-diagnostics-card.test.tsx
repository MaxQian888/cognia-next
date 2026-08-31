/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { UsageDiagnosticsCard, legacyWindowsToMeters } from "./usage-diagnostics-card"
import { buildUsageScope } from "@/lib/usage/usage-report"
import type { UsageDiagnosticsBlock } from "@/lib/slash-commands/system-blocks"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { LimitsMeter } from "@/types/subscription"
import { useSettingsStore } from "@/stores/settings"

const NOW = new Date("2026-08-29T12:00:00Z").getTime()
const HOUR = 3_600_000

let tickerNow = new Date("2026-08-29T12:00:00Z").getTime()
jest.mock("@/lib/subscription/core/now-ticker", () => ({
  useSubscriptionNow: () => tickerNow,
  SUBSCRIPTION_TICK_MS: 30_000,
}))

const writeClipboardText = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (text: string) => writeClipboardText(text),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

function meter(overrides: Partial<LimitsMeter> = {}): LimitsMeter {
  return {
    id: "session",
    labelKey: "subscription.limits.meter.session",
    kind: "window",
    usedPct: 11,
    resetAt: NOW + 2 * HOUR + 41 * 60_000,
    status: "ok",
    ...overrides,
  }
}

function usageRow(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    at: NOW,
    model: "claude-opus-5",
    providerId: "anthropic",
    inputTokens: 1400,
    outputTokens: 5500,
    cacheCreationTokens: 1_100_000,
    cacheReadTokens: 244_000_000,
    costUsd: 86.79,
    durationMs: 137_000,
    costSource: "sdk",
    costKnown: true,
    surface: "chat",
    ...overrides,
  }
}

function block(overrides: Partial<UsageDiagnosticsBlock> = {}): UsageDiagnosticsBlock {
  return {
    kind: "usage",
    meters: [
      meter(),
      meter({
        id: "weekly",
        labelKey: "subscription.limits.meter.weekly",
        usedPct: 82,
        status: "warn",
        resetAt: NOW + 3 * 24 * HOUR,
      }),
      meter({
        id: "weekly_opus",
        labelKey: "subscription.limits.meter.weekly_opus",
        usedPct: 0,
        status: "ok",
        resetAt: NOW + 3 * 24 * HOUR,
      }),
    ],
    extras: [],
    source: "endpoint",
    fetchedAt: NOW - 60_000,
    status: null,
    representativeClaim: null,
    fallbackPercentage: null,
    overageDisabledReason: null,
    scopes: [
      buildUsageScope("session", [usageRow()]),
      buildUsageScope("today", [usageRow(), usageRow({ surface: "agent-team", costUsd: 12 })]),
      buildUsageScope("week", [usageRow(), usageRow({ surface: "agent-team", costUsd: 12 })]),
    ],
    hasSession: true,
    notes: [],
    generatedAt: NOW,
    ...overrides,
  }
}

describe("UsageDiagnosticsCard — plan limits", () => {
  it("renders every fused quota window, including the per-model weekly tiers", () => {
    render(<UsageDiagnosticsCard block={block()} />)
    expect(screen.getByTestId("limits-meter-usage-session")).toBeInTheDocument()
    expect(screen.getByTestId("limits-meter-usage-weekly")).toBeInTheDocument()
    // The tier the header path cannot see at all.
    expect(screen.getByTestId("limits-meter-usage-weekly_opus")).toBeInTheDocument()
    expect(screen.getByText("Current week (Opus only)")).toBeInTheDocument()
  })

  it("carries the muted tint as an inline style, not an arbitrary-property class", () => {
    // `[data-surface-layer="raised"] { --surface-bg: … }` is unlayered in
    // globals.css and beats any `@layer utilities` class, so the tint has to
    // be inline or the card paints the opaque tier value.
    render(<UsageDiagnosticsCard block={block()} />)
    const card = screen.getByTestId("diagnostics-card")
    expect(card.style.getPropertyValue("--surface-bg")).toContain("color-mix")
    expect(card.className).not.toContain("[--surface-bg:")
  })

  it("counts a near reset down and states a far one as a weekday and time", () => {
    render(<UsageDiagnosticsCard block={block()} />)
    expect(screen.getByText("Resets in 2h 41m")).toBeInTheDocument()
    expect(screen.queryByText(/Resets in 7[0-9]h/)).not.toBeInTheDocument()
  })

  it("says so when no quota window could be read at all", () => {
    render(<UsageDiagnosticsCard block={block({ meters: [], windows: undefined })} />)
    expect(screen.getByTestId("usage-no-windows")).toBeInTheDocument()
  })

  it("renders the pay-as-you-go overage meter alongside the windows", () => {
    render(
      <UsageDiagnosticsCard
        block={block({
          extras: [
            {
              id: "overage",
              labelKey: "subscription.limits.meter.overage",
              kind: "balance",
              usedPct: 40,
              used: 40,
              total: 100,
              remaining: 60,
              currency: "USD",
              status: "ok",
            },
          ],
        })}
      />
    )
    expect(screen.getByTestId("usage-extras")).toBeInTheDocument()
    expect(screen.getByText("$60 left")).toBeInTheDocument()
  })

  it("renders the fallback buffer as a whole percent, not the raw fraction", () => {
    render(<UsageDiagnosticsCard block={block({ fallbackPercentage: 0.2 })} />)
    expect(screen.getByText("20%")).toBeInTheDocument()
  })

  it("surfaces the overage-disabled reason verbatim", () => {
    render(<UsageDiagnosticsCard block={block({ overageDisabledReason: "org_level_disabled" })} />)
    expect(screen.getByText("org_level_disabled")).toBeInTheDocument()
  })

  it("shows the unified status pill only when the header sample is the source", () => {
    const { rerender } = render(<UsageDiagnosticsCard block={block()} />)
    expect(screen.queryByTestId("usage-status")).not.toBeInTheDocument()
    rerender(<UsageDiagnosticsCard block={block({ status: "rate_limited", source: "headers" })} />)
    expect(screen.getByTestId("usage-status")).toHaveAttribute("data-status", "rate_limited")
    expect(screen.getByText("Rate limited")).toBeInTheDocument()
  })

  it("names the winning snapshot and how old it is", () => {
    render(<UsageDiagnosticsCard block={block()} />)
    expect(screen.getByTestId("usage-source")).toHaveTextContent("Live usage API")
    expect(screen.getByTestId("usage-source")).toHaveTextContent("updated 1m ago")
  })

  it("says no reading is available when neither source produced one", () => {
    render(<UsageDiagnosticsCard block={block({ source: null, fetchedAt: null, meters: [] })} />)
    expect(screen.getByText("No quota reading available")).toBeInTheDocument()
  })
})

describe("UsageDiagnosticsCard — local spend", () => {
  it("shows headline spend stats for the active scope", () => {
    render(<UsageDiagnosticsCard block={block()} />)
    expect(screen.getByTestId("usage-stat-cost")).toHaveTextContent("$86.79")
    expect(screen.getByTestId("usage-stat-turns")).toHaveTextContent("1")
    expect(screen.getByTestId("usage-stat-active")).toHaveTextContent("2m 17s")
    // 244M read of 245.1M prompt tokens.
    expect(screen.getByTestId("usage-stat-cache")).toHaveTextContent("100%")
  })

  it("switches every spend figure when another scope is picked", async () => {
    const user = userEvent.setup()
    render(<UsageDiagnosticsCard block={block()} />)
    expect(screen.getByTestId("usage-stat-turns")).toHaveTextContent("1")
    await user.click(screen.getByTestId("usage-scope-today"))
    expect(screen.getByTestId("usage-stat-turns")).toHaveTextContent("2")
  })

  it("hides the session scope when the command ran without an active session", () => {
    render(<UsageDiagnosticsCard block={block({ hasSession: false })} />)
    expect(screen.queryByTestId("usage-scope-session")).not.toBeInTheDocument()
    expect(screen.getByTestId("usage-scope-today")).toBeInTheDocument()
  })

  it("reports an empty scope rather than rendering zeroes as a measurement", () => {
    render(
      <UsageDiagnosticsCard
        block={block({
          scopes: [
            buildUsageScope("session", []),
            buildUsageScope("today", []),
            buildUsageScope("week", []),
          ],
        })}
      />
    )
    expect(screen.getByTestId("usage-scope-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-attribution")).not.toBeInTheDocument()
  })

  it("marks a scope containing unpriced turns as a lower bound", () => {
    render(
      <UsageDiagnosticsCard
        block={block({
          scopes: [
            buildUsageScope("session", [
              usageRow({ costUsd: 5, costSource: "sdk", costKnown: true }),
              usageRow({ costUsd: 0, costSource: "unknown", costKnown: false }),
            ]),
          ],
        })}
      />
    )
    expect(screen.getByTestId("usage-stat-cost")).toHaveTextContent("≥")
    expect(screen.getByTestId("usage-unpriced")).toBeInTheDocument()
  })

  it("renders an em dash, never $0.00, when nothing in the scope could be priced", () => {
    render(
      <UsageDiagnosticsCard
        block={block({
          scopes: [
            buildUsageScope("session", [
              usageRow({ costUsd: 0, costSource: "unknown", costKnown: false }),
            ]),
          ],
        })}
      />
    )
    expect(screen.getByTestId("usage-stat-cost")).toHaveTextContent("—")
  })
})

describe("UsageDiagnosticsCard — scope capture time", () => {
  it("stays quiet while the card is being read in the window it describes", () => {
    render(<UsageDiagnosticsCard block={block({ generatedAt: NOW - 60_000 })} />)
    expect(screen.queryByTestId("usage-captured-at")).not.toBeInTheDocument()
  })

  it("says which moment the scopes are relative to once that has drifted", () => {
    // "Today" means the day the command ran. Read back tomorrow, that label
    // silently describes a window the reader is no longer in.
    render(<UsageDiagnosticsCard block={block({ generatedAt: NOW - 3 * 24 * HOUR })} />)
    expect(screen.getByTestId("usage-captured-at")).toBeInTheDocument()
  })

  it("says nothing when the block never recorded when it was captured", () => {
    render(<UsageDiagnosticsCard block={block({ generatedAt: undefined })} />)
    expect(screen.queryByTestId("usage-captured-at")).not.toBeInTheDocument()
  })
})

describe("UsageDiagnosticsCard — attribution", () => {
  it("groups by surface with translated labels, and switches to models on demand", async () => {
    const user = userEvent.setup()
    render(<UsageDiagnosticsCard block={block()} />)
    await user.click(screen.getByTestId("usage-scope-today"))
    expect(screen.getByTestId("usage-attribution-chat")).toBeInTheDocument()
    expect(screen.getByTestId("usage-attribution-agent-team")).toBeInTheDocument()
    expect(screen.getByText("Agent Team")).toBeInTheDocument()

    await user.click(screen.getByTestId("usage-axis-model"))
    expect(screen.getByTestId("usage-attribution-claude-opus-5")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-attribution-agent-team")).not.toBeInTheDocument()
  })

  it("ranks by token share when nothing in the scope has a known price", async () => {
    const user = userEvent.setup()
    render(
      <UsageDiagnosticsCard
        block={block({
          scopes: [
            buildUsageScope("session", [
              usageRow({ surface: "chat", costUsd: 0, costSource: "unknown", costKnown: false }),
            ]),
          ],
        })}
      />
    )
    // Cost share is unusable, so the bar falls back to the token share (100%).
    expect(screen.getByTestId("usage-attribution-chat")).toHaveTextContent("100%")
    expect(user).toBeTruthy()
  })
})

describe("UsageDiagnosticsCard — display density", () => {
  function withMode(mode: "simplified" | "standard" | "detailed") {
    // `act` because the store drives mounted trees from the previous case.
    act(() => {
      useSettingsStore.setState({ settings: { usageDisplayMode: { mode } } as never })
    })
  }

  afterEach(() => {
    act(() => {
      useSettingsStore.setState({ settings: null as never })
    })
  })

  const manyRows = [
    usageRow({ surface: "chat", costUsd: 10 }),
    usageRow({ surface: "agent-team", costUsd: 8 }),
    usageRow({ surface: "workflow", costUsd: 6 }),
    usageRow({ surface: "connector", costUsd: 4 }),
    usageRow({ surface: "goal", costUsd: 2 }),
    usageRow({ surface: "ocr", costUsd: 1 }),
  ]
  const dense = () => block({ scopes: [buildUsageScope("session", manyRows)], hasSession: true })

  it("simplified drops the token breakdown and the contributor list", () => {
    withMode("simplified")
    render(<UsageDiagnosticsCard block={dense()} />)
    expect(screen.queryByTestId("usage-contributors")).not.toBeInTheDocument()
    expect(screen.queryByText("Output")).not.toBeInTheDocument()
    // Three of six surfaces, with the tail acknowledged rather than dropped.
    expect(screen.getByTestId("usage-attribution-more")).toHaveTextContent("3 more not shown")
  })

  it("standard adds the token breakdown and the contributors", () => {
    withMode("standard")
    render(<UsageDiagnosticsCard block={dense()} />)
    expect(screen.getByText("Output")).toBeInTheDocument()
    expect(screen.getByTestId("usage-contributors")).toBeInTheDocument()
    expect(screen.getByTestId("usage-attribution-more")).toHaveTextContent("1 more not shown")
  })

  it("detailed shows every bucket with its turn count, and the representative window", () => {
    withMode("detailed")
    render(<UsageDiagnosticsCard block={{ ...dense(), representativeClaim: "five_hour" }} />)
    expect(screen.queryByTestId("usage-attribution-more")).not.toBeInTheDocument()
    expect(screen.getByTestId("usage-attribution-ocr")).toBeInTheDocument()
    expect(screen.getAllByText(/1 turn ·/).length).toBeGreaterThan(0)
    expect(screen.getByText("5-hour")).toBeInTheDocument()
  })
})

describe("UsageDiagnosticsCard — notes", () => {
  it("explains each degraded plane and interpolates the provider detail", () => {
    render(
      <UsageDiagnosticsCard
        block={block({
          notes: [
            { id: "web-mode" },
            { id: "query-disabled" },
            { id: "quota-error", detail: "429 Too Many Requests" },
            { id: "stale" },
          ],
        })}
      />
    )
    expect(screen.getByTestId("usage-note-web-mode")).toHaveTextContent("desktop app")
    expect(screen.getByTestId("usage-note-query-disabled")).toBeInTheDocument()
    expect(screen.getByTestId("usage-note-quota-error")).toHaveTextContent("429 Too Many Requests")
    expect(screen.getByTestId("usage-note-stale")).toBeInTheDocument()
  })

  it("renders no note list at all when nothing degraded", () => {
    render(<UsageDiagnosticsCard block={block()} />)
    expect(screen.queryByTestId("usage-notes")).not.toBeInTheDocument()
  })
})

describe("UsageDiagnosticsCard — copy", () => {
  beforeEach(() => {
    writeClipboardText.mockClear()
    toastSuccess.mockClear()
    toastError.mockClear()
  })

  it("copies the same figures the card shows, caveats included", async () => {
    const user = userEvent.setup()
    render(
      <UsageDiagnosticsCard
        block={block({
          scopes: [
            buildUsageScope("session", [
              usageRow({ costUsd: 5, costSource: "sdk", costKnown: true }),
              usageRow({ costUsd: 0, costSource: "unknown", costKnown: false }),
            ]),
          ],
        })}
      />
    )
    await user.click(screen.getByTestId("usage-copy"))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalled())
    const text = writeClipboardText.mock.calls[0][0] as string
    expect(text).toContain("Subscription usage")
    expect(text).toContain("Current session")
    expect(text).toContain("≥")
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("reports a clipboard failure instead of silently doing nothing", async () => {
    writeClipboardText.mockRejectedValueOnce(new Error("denied"))
    const user = userEvent.setup()
    render(<UsageDiagnosticsCard block={block()} />)
    await user.click(screen.getByTestId("usage-copy"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})

describe("legacyWindowsToMeters", () => {
  it("renders a v1 block recorded before the block carried meters", () => {
    render(
      <UsageDiagnosticsCard
        block={{
          kind: "usage",
          windows: [
            { key: "fiveHour", utilization: 42, level: "ok", msUntilReset: 4_500_000 },
            { key: "sevenDay", utilization: null, level: null, msUntilReset: null },
          ],
          fallbackPercentage: null,
          overageDisabledReason: null,
        }}
      />
    )
    expect(screen.getByTestId("limits-meter-usage-session")).toBeInTheDocument()
    expect(screen.getByText("42% used")).toBeInTheDocument()
    // The window the v1 block could not measure is dropped, not shown as 0%.
    expect(screen.queryByTestId("limits-meter-usage-weekly")).not.toBeInTheDocument()
  })

  it("still counts down when the shared ticker has not warmed up yet", () => {
    // `useSyncExternalStore` reads the snapshot one render before it
    // subscribes, so a cold ticker can hand the first render a 0. Resolving a
    // stored countdown against that produced a 1970 date — a plausible-looking
    // wrong answer rather than an obviously missing one.
    tickerNow = 0
    try {
      render(
        <UsageDiagnosticsCard
          block={{
            kind: "usage",
            windows: [
              { key: "fiveHour", utilization: 72, level: "warn", msUntilReset: 95 * 60_000 },
            ],
            fallbackPercentage: null,
            overageDisabledReason: null,
          }}
        />
      )
      expect(screen.getByText("Resets in 1h 35m")).toBeInTheDocument()
    } finally {
      tickerNow = NOW
    }
  })

  it("counts a v1 block's stored countdown down, instead of dating it", () => {
    // The v1 shape stores `msUntilReset`, never an instant, and never recorded
    // when the command ran — a card that resolved that against epoch 0 printed
    // a calendar date decades out.
    render(
      <UsageDiagnosticsCard
        block={{
          kind: "usage",
          windows: [{ key: "fiveHour", utilization: 72, level: "warn", msUntilReset: 95 * 60_000 }],
          fallbackPercentage: null,
          overageDisabledReason: null,
        }}
      />
    )
    expect(screen.getByText("Resets in 1h 35m")).toBeInTheDocument()
  })

  it("rebases the stored countdown onto the instant the command ran", () => {
    const [session] = legacyWindowsToMeters(
      [{ key: "fiveHour", utilization: 10, level: "ok", msUntilReset: HOUR }],
      NOW
    )
    expect(session.resetAt).toBe(NOW + HOUR)
  })

  it("keeps a window with no reset time rather than inventing one", () => {
    const [session] = legacyWindowsToMeters(
      [{ key: "fiveHour", utilization: 10, level: "ok", msUntilReset: null }],
      NOW
    )
    expect(session.resetAt).toBeNull()
  })
})
