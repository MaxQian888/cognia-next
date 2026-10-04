/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("./native-log-viewer", () => ({
  NativeLogViewer: () => <div data-testid="stub-native-log-viewer" />,
}))

import {
  LogPanelStatsBar,
  TransportHealthDetail,
  TransportHealthSummary,
  NativeLoggingDetail,
  LOG_SETTINGS_HREF,
  type LogPanelStatsBarProps,
  type TransportHealthSummaryProps,
} from "./log-panel-stats-bar"
import type { TransportHealthSnapshot } from "@cognia/logging"
import type { UseTransportHealthResult } from "@/hooks/logging"

function makeNativeLogging(
  overrides: Partial<UseTransportHealthResult["nativeLogging"]> = {}
): UseTransportHealthResult["nativeLogging"] {
  return {
    runtime: "browser" as UseTransportHealthResult["nativeLogging"]["runtime"],
    status: "inactive",
    startupMode: "off" as UseTransportHealthResult["nativeLogging"]["startupMode"],
    bridgeState: "uninitialized" as UseTransportHealthResult["nativeLogging"]["bridgeState"],
    activeTargets: [],
    fallbackReason: null,
    bridgeLastError: null,
    ...overrides,
  } as UseTransportHealthResult["nativeLogging"]
}

function makeHealth(overrides: Partial<TransportHealthSnapshot> = {}): TransportHealthSnapshot {
  return {
    transport: "remote",
    status: "healthy",
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    ...overrides,
  } as TransportHealthSnapshot
}

function defaultProps(overrides: Partial<LogPanelStatsBarProps> = {}): LogPanelStatsBarProps {
  return {
    logRate: 30,
    autoRefresh: true,
    ...overrides,
  }
}

function renderBar(overrides: Partial<LogPanelStatsBarProps> = {}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <LogPanelStatsBar {...defaultProps(overrides)} />
    </TooltipProvider>
  )
}

function summaryProps(
  overrides: Partial<TransportHealthSummaryProps> = {}
): TransportHealthSummaryProps {
  return {
    healthByTransport: {},
    nativeLogging: makeNativeLogging(),
    onTransportClick: jest.fn(),
    onNativeLoggingClick: jest.fn(),
    ...overrides,
  }
}

function renderSummary(overrides: Partial<TransportHealthSummaryProps> = {}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <TransportHealthSummary {...summaryProps(overrides)} />
    </TooltipProvider>
  )
}

describe("LogPanelStatsBar", () => {
  it("renders the live rate with a decorative pulse", () => {
    renderBar()
    const rate = screen.getByTestId("log-panel-log-rate")
    expect(rate).toHaveTextContent("~30 logs/min")
    // The pulse is decoration: hidden from assistive tech, not an unroled span
    // with an aria-label.
    const pulse = rate.querySelector(".animate-pulse, .motion-safe\\:animate-pulse")
    expect(pulse).toHaveAttribute("aria-hidden")
    expect(pulse).not.toHaveAttribute("aria-label")
  })

  it("no longer restates the active tab's count as a range, and has no pager", () => {
    renderBar()
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Previous Page")).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("renders nothing when there is neither a rate nor a full window", () => {
    const { container } = renderBar({ logRate: 0, windowCapped: false })
    expect(container.querySelector('[data-testid="log-panel-stats-bar"]')).toBeNull()
  })

  it("leaves per-level counts to the level tabs rather than restating them", () => {
    // `stats.byLevel` is no longer a prop: the level-filter row this bar now
    // shares already badges every level, and the bar sat directly beneath it.
    renderBar()
    expect(screen.queryByText(/^Info:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument()
  })

  it("omits the log rate when logRate is 0", () => {
    renderBar({ logRate: 0, windowCapped: true, windowSize: 1000 })
    expect(screen.queryByTestId("log-panel-log-rate")).not.toBeInTheDocument()
    expect(screen.getByTestId("log-panel-window-cap")).toBeInTheDocument()
  })
})

describe("TransportHealthSummary", () => {
  function openSummary() {
    fireEvent.click(screen.getByTestId("transport-health-summary-trigger"))
  }

  it("collapses healthy transports into one chip with a healthy/total count", () => {
    renderSummary({
      healthByTransport: {
        remote: makeHealth({ transport: "remote", status: "healthy" }),
        indexedDB: makeHealth({ transport: "indexedDB", status: "healthy" }),
      },
    })
    const trigger = screen.getByTestId("transport-health-summary-trigger")
    expect(trigger).toHaveTextContent("2/2")
    expect(trigger).toHaveAttribute("data-tone", "success")
    expect(trigger).toHaveAttribute("aria-label", "Log transports: 2 of 2 healthy")
    // Healthy transports never sit inline — that is what used to wrap the row.
    expect(screen.queryByTestId("transport-tile-remote")).not.toBeInTheDocument()
  })

  it("puts problem transports inline, worst first, and tones the chip by the worst", () => {
    renderSummary({
      healthByTransport: {
        remote: makeHealth({ transport: "remote", status: "healthy" }),
        langfuse: makeHealth({ transport: "langfuse", status: "degraded", queueDepth: 3 }),
        otel: makeHealth({ transport: "otel", status: "offline", queueDepth: 5 }),
      },
    })
    const inline = screen
      .getByTestId("transport-health-summary")
      .querySelectorAll('[data-testid^="transport-tile-"]')
    expect(Array.from(inline).map((node) => node.getAttribute("data-testid"))).toEqual([
      "transport-tile-otel",
      "transport-tile-langfuse",
    ])
    expect(screen.getByTestId("transport-health-summary-trigger")).toHaveAttribute(
      "data-tone",
      "danger"
    )
    expect(screen.getByTestId("transport-health-summary-trigger")).toHaveTextContent("1/3")
  })

  it("caps the inline problem tiles at two; the popover lists everything", () => {
    const healthByTransport: Record<string, TransportHealthSnapshot> = {}
    for (const name of ["a", "b", "c"]) {
      healthByTransport[name] = makeHealth({ transport: name, status: "offline" })
    }
    healthByTransport.ok = makeHealth({ transport: "ok", status: "healthy" })
    renderSummary({ healthByTransport })
    expect(
      screen
        .getByTestId("transport-health-summary")
        .querySelectorAll('[data-testid^="transport-tile-"]')
    ).toHaveLength(2)
    openSummary()
    const group = screen.getByTestId("transport-health-tile-group")
    expect(group.querySelectorAll('[data-testid^="transport-tile-"]')).toHaveLength(4)
    // Worst first, healthy last.
    expect(group.lastElementChild).toHaveAttribute("data-testid", "transport-tile-ok")
  })

  it("clicking a tile in the popover fires onTransportClick and closes it", () => {
    const onTransportClick = jest.fn()
    renderSummary({
      healthByTransport: { remote: makeHealth({ transport: "remote" }) },
      onTransportClick,
    })
    openSummary()
    fireEvent.click(screen.getByTestId("transport-tile-remote"))
    expect(onTransportClick).toHaveBeenCalledWith("remote")
    expect(screen.queryByTestId("transport-health-tile-group")).not.toBeInTheDocument()
  })

  it("clicking an inline problem tile fires onTransportClick", () => {
    const onTransportClick = jest.fn()
    renderSummary({
      healthByTransport: { remote: makeHealth({ transport: "remote", status: "degraded" }) },
      onTransportClick,
    })
    fireEvent.click(screen.getByTestId("transport-tile-remote"))
    expect(onTransportClick).toHaveBeenCalledWith("remote")
  })

  it("includes the native tile only when runtime is tauri", () => {
    const { rerender } = renderSummary({
      nativeLogging: makeNativeLogging({
        runtime: "browser" as UseTransportHealthResult["nativeLogging"]["runtime"],
      }),
    })
    // No transports and no native host → nothing to summarise.
    expect(screen.queryByTestId("transport-health-summary")).not.toBeInTheDocument()
    rerender(
      <TooltipProvider delayDuration={0}>
        <TransportHealthSummary
          {...summaryProps({
            nativeLogging: makeNativeLogging({ runtime: "tauri", status: "healthy" }),
          })}
        />
      </TooltipProvider>
    )
    openSummary()
    const native = screen.getByTestId("transport-tile-native")
    // The tile is named in the user's language, not by the word "native".
    expect(native).toHaveAttribute("aria-label", "Native logging: healthy")
    expect(native).toHaveTextContent("Native")
  })

  it("counts the native tile in the chip's denominator on Tauri", () => {
    renderSummary({
      healthByTransport: { remote: makeHealth({ transport: "remote", status: "healthy" }) },
      nativeLogging: makeNativeLogging({ runtime: "tauri", status: "degraded" }),
    })
    expect(screen.getByTestId("transport-health-summary-trigger")).toHaveTextContent("1/2")
  })

  it("abbreviates queue depth and drops through the message bundle", () => {
    renderSummary({
      healthByTransport: {
        remote: makeHealth({
          transport: "remote",
          status: "degraded",
          queueDepth: 7,
          droppedEntries: 2,
        }),
      },
    })
    const tile = screen.getByTestId("transport-tile-remote")
    expect(tile).toHaveTextContent("q7")
    expect(tile).toHaveTextContent("d2")
  })

  it("a degraded native pipeline sits inline and its click fires onNativeLoggingClick", () => {
    const onNativeLoggingClick = jest.fn()
    renderSummary({
      nativeLogging: makeNativeLogging({ runtime: "tauri", status: "degraded" }),
      onNativeLoggingClick,
    })
    fireEvent.click(screen.getByTestId("transport-tile-native"))
    expect(onNativeLoggingClick).toHaveBeenCalledTimes(1)
  })

  it("applies the danger tone when transport is offline", () => {
    renderSummary({
      healthByTransport: { remote: makeHealth({ transport: "remote", status: "offline" }) },
    })
    expect(screen.getByTestId("transport-tile-remote")).toHaveAttribute("data-tone", "danger")
  })

  it("names tiles in the user's language", () => {
    renderSummary({
      healthByTransport: {
        remote: makeHealth({ transport: "remote", status: "offline", queueDepth: 4 }),
      },
    })
    expect(screen.getByTestId("transport-tile-remote")).toHaveAttribute(
      "aria-label",
      "remote: offline, queue 4"
    )
  })

  it("shows formatted relative time (just now) for recent events", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-01-01T12:00:00Z"))
    renderSummary({
      healthByTransport: {
        recent: makeHealth({
          transport: "recent",
          status: "degraded",
          lastSuccessAt: new Date("2026-01-01T12:00:00Z").toISOString(),
          updatedAt: new Date("2026-01-01T12:00:00Z").toISOString(),
        }),
      },
    })
    expect(screen.getByTestId("transport-tile-recent").textContent).toMatch(/just now/)
    act(() => {
      jest.useRealTimers()
    })
  })

  it("formats seconds / minutes / hours / days ago", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-01-02T12:00:00Z"))
    const now = Date.now()
    const tonesAndExpectedFragments: Array<[number, RegExp]> = [
      [now - 10_000, /10s ago/],
      [now - 5 * 60_000, /5m ago/],
      [now - 3 * 60 * 60_000, /3h ago/],
      [now - 2 * 24 * 60 * 60_000, /2d ago/],
    ]
    for (const [ms, frag] of tonesAndExpectedFragments) {
      const { unmount } = renderSummary({
        healthByTransport: {
          age: makeHealth({
            transport: "age",
            status: "degraded",
            lastSuccessAt: new Date(ms).toISOString(),
            updatedAt: new Date(ms).toISOString(),
          }),
        },
      })
      expect(screen.getByTestId("transport-tile-age").textContent).toMatch(frag)
      unmount()
    }
    act(() => {
      jest.useRealTimers()
    })
  })

  it("returns dash placeholder for missing or invalid timestamps", () => {
    renderSummary({
      healthByTransport: {
        none: makeHealth({
          transport: "none",
          status: "degraded",
          lastSuccessAt: undefined,
          lastFailureAt: undefined,
          updatedAt: "not-a-date",
        }),
      },
    })
    expect(screen.getByTestId("transport-tile-none").textContent).toMatch(/—/)
  })

  it("renders an inactive native tile with the muted tone", () => {
    renderSummary({
      nativeLogging: makeNativeLogging({ runtime: "tauri", status: "inactive" }),
    })
    openSummary()
    expect(screen.getByTestId("transport-tile-native")).toHaveAttribute("data-tone", "muted")
  })
})

describe("LogPanelStatsBar — loaded window", () => {
  it("says when the newest-N window is full", () => {
    renderBar({ windowCapped: true, windowSize: 1000 })
    expect(screen.getByTestId("log-panel-window-cap")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("1000")
    )
  })

  it("says nothing when it is not", () => {
    renderBar({ windowCapped: false, windowSize: 1000 })
    expect(screen.queryByTestId("log-panel-window-cap")).not.toBeInTheDocument()
  })
})

describe("TransportHealthDetail", () => {
  it("renders MetricCells and reacts to Close + ViewDiagnostics", () => {
    const onClose = jest.fn()
    const onViewDiagnostics = jest.fn()
    render(
      <TransportHealthDetail
        health={makeHealth({
          transport: "remote",
          status: "degraded",
          queueDepth: 12,
          retryCount: 3,
          droppedEntries: 1,
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: new Date().toISOString(),
          lastError: "timeout",
        })}
        history={[1, 2, 3, 4, 5]}
        onClose={onClose}
        onViewDiagnostics={onViewDiagnostics}
      />
    )
    expect(screen.getByText("12")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("timeout")).toBeInTheDocument()
    expect(screen.getByTestId("transport-health-sparkline")).toBeInTheDocument()
    // One translated title with the name in it, not "Transport Details" + ": remote".
    expect(screen.getByText("Transport details: remote")).toBeInTheDocument()
    expect(screen.getByTestId("transport-detail-settings")).toHaveAttribute(
      "href",
      LOG_SETTINGS_HREF
    )
    fireEvent.click(screen.getByText("Close"))
    fireEvent.click(screen.getByText("View Diagnostics"))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onViewDiagnostics).toHaveBeenCalledTimes(1)
  })

  it("falls back to dash placeholder for sparkline when history < 2 points", () => {
    render(
      <TransportHealthDetail
        health={makeHealth({ transport: "remote" })}
        history={[1]}
        onClose={jest.fn()}
        onViewDiagnostics={jest.fn()}
      />
    )
    // Sparkline component shows "—" placeholder, not the svg
    expect(screen.queryByTestId("transport-health-sparkline")).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Queue depth history/)).toHaveTextContent("—")
  })

  it("omits the sparkline entirely when no history is provided", () => {
    render(
      <TransportHealthDetail
        health={makeHealth({ transport: "remote" })}
        onClose={jest.fn()}
        onViewDiagnostics={jest.fn()}
      />
    )
    expect(screen.queryByTestId("transport-health-sparkline")).not.toBeInTheDocument()
  })

  it("renders last-failure tone differently when failure timestamp is set", () => {
    const { container } = render(
      <TransportHealthDetail
        health={makeHealth({
          transport: "remote",
          lastFailureAt: new Date(Date.now() - 65_000).toISOString(),
        })}
        onClose={jest.fn()}
        onViewDiagnostics={jest.fn()}
      />
    )
    expect(container.querySelector(".border-warning\\/40")).toBeInTheDocument()
  })
})

describe("NativeLoggingDetail", () => {
  it("renders translated status / mode / bridge / targets fields and reacts to close", () => {
    const onClose = jest.fn()
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging({
          runtime: "tauri",
          status: "healthy",
          startupMode: "fallback",
          bridgeState: "degraded",
          activeTargets: ["console", "file"],
        })}
        onClose={onClose}
      />
    )
    expect(screen.getByText("Status: healthy")).toBeInTheDocument()
    expect(screen.getByText("Startup Mode: Fallback")).toBeInTheDocument()
    expect(screen.getByText("Bridge: degraded")).toBeInTheDocument()
    expect(screen.getByText("Targets: console, file")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("prints a value it has no words for as reported", () => {
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging({
          startupMode: "spawn" as UseTransportHealthResult["nativeLogging"]["startupMode"],
        })}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("Startup Mode: spawn")).toBeInTheDocument()
  })

  it('shows the localized "none" placeholder when activeTargets is empty', () => {
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging({ activeTargets: [] })}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("Targets: none")).toBeInTheDocument()
  })

  it("renders fallback reason and bridge error when present", () => {
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging({
          fallbackReason: { message: "ipc-init failed" } as never,
          bridgeLastError: "EPIPE",
        })}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText(/ipc-init failed/)).toBeInTheDocument()
    expect(screen.getByText(/EPIPE/)).toBeInTheDocument()
  })

  it("mounts the native log viewer and links to the log settings instead of guessing a search", () => {
    render(<NativeLoggingDetail nativeLogging={makeNativeLogging()} onClose={jest.fn()} />)
    expect(screen.getByTestId("stub-native-log-viewer")).toBeInTheDocument()
    expect(screen.getByTestId("native-detail-settings")).toHaveAttribute("href", LOG_SETTINGS_HREF)
    expect(screen.queryByText("View Native Diagnostics")).not.toBeInTheDocument()
  })
})
