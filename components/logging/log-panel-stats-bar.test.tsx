/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

import {
  LogPanelStatsBar,
  TransportHealthDetail,
  NativeLoggingDetail,
  type LogPanelStatsBarProps,
} from "./log-panel-stats-bar"
import type { LogLevel, TransportHealthSnapshot } from "@cognia/logging"
import type { UseTransportHealthResult } from "@/hooks/logging"

function zeroByLevel(overrides: Partial<Record<LogLevel, number>> = {}) {
  return {
    trace: 0,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
    ...overrides,
  }
}

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
    filteredCount: 100,
    totalCount: 200,
    stats: { byLevel: zeroByLevel({ info: 60, error: 5 }) },
    logRate: 30,
    autoRefresh: true,
    healthByTransport: {},
    nativeLogging: makeNativeLogging(),
    onTransportClick: jest.fn(),
    onNativeLoggingClick: jest.fn(),
    currentPage: 1,
    totalPages: 3,
    pageSize: 50,
    pageSizeOptions: [50, 100, 200] as const,
    onPageChange: jest.fn(),
    onPageSizeChange: jest.fn(),
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

describe("LogPanelStatsBar", () => {
  it("renders the showing-range, per-level counts, and live-rate pulse", () => {
    renderBar()
    expect(screen.getByText(/100/)).toBeInTheDocument()
    expect(screen.getByText("60")).toBeInTheDocument()
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText(/logs\/min/)).toBeInTheDocument()
    expect(screen.getByText(/30/)).toBeInTheDocument()
  })

  it("omits the slash-total span when filteredCount equals totalCount", () => {
    renderBar({ filteredCount: 100, totalCount: 100 })
    expect(screen.queryByText("/ 100")).not.toBeInTheDocument()
  })

  it("omits the log-rate pulse when logRate is 0", () => {
    renderBar({ logRate: 0 })
    expect(screen.queryByLabelText("Live log stream activity")).not.toBeInTheDocument()
  })

  it("renders pagination when totalPages > 1", () => {
    renderBar({ totalPages: 5 })
    expect(screen.getByText("1 / 5")).toBeInTheDocument()
    expect(screen.getByLabelText("Previous Page")).toBeInTheDocument()
    expect(screen.getByLabelText("Next Page")).toBeInTheDocument()
  })

  it("hides pagination when totalPages <= 1", () => {
    renderBar({ totalPages: 1 })
    expect(screen.queryByText("1 / 1")).not.toBeInTheDocument()
  })

  it("disables prev on page 1 and next on last page", () => {
    const { rerender } = renderBar({ currentPage: 1, totalPages: 3 })
    expect(screen.getByLabelText("Previous Page")).toBeDisabled()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelStatsBar {...defaultProps({ currentPage: 3, totalPages: 3 })} />
      </TooltipProvider>
    )
    expect(screen.getByLabelText("Next Page")).toBeDisabled()
  })

  it("fires onPageChange when prev / next clicked", () => {
    const onPageChange = jest.fn()
    renderBar({ onPageChange, currentPage: 2, totalPages: 5 })
    fireEvent.click(screen.getByLabelText("Previous Page"))
    fireEvent.click(screen.getByLabelText("Next Page"))
    expect(onPageChange).toHaveBeenCalledWith(1)
    expect(onPageChange).toHaveBeenCalledWith(3)
  })
})

describe("TransportHealthTileGroup", () => {
  it("renders up to 3 inline tiles and groups the rest under an overflow popover", () => {
    const healthByTransport: Record<string, TransportHealthSnapshot> = {
      remote: makeHealth({ transport: "remote", status: "healthy", queueDepth: 1 }),
      langfuse: makeHealth({ transport: "langfuse", status: "degraded", queueDepth: 3 }),
      otel: makeHealth({ transport: "otel", status: "offline", queueDepth: 5 }),
      indexedDB: makeHealth({ transport: "indexedDB", status: "healthy", queueDepth: 0 }),
    }
    renderBar({ healthByTransport })
    expect(screen.getByTestId("transport-tile-remote")).toBeInTheDocument()
    expect(screen.getByTestId("transport-tile-langfuse")).toBeInTheDocument()
    expect(screen.getByTestId("transport-tile-otel")).toBeInTheDocument()
    expect(screen.queryByTestId("transport-tile-indexedDB")).not.toBeInTheDocument()
    expect(screen.getByTestId("transport-tile-overflow")).toBeInTheDocument()
  })

  it("clicking a tile fires onTransportClick with that transport name", () => {
    const onTransportClick = jest.fn()
    renderBar({
      healthByTransport: {
        remote: makeHealth({ transport: "remote" }),
      },
      onTransportClick,
    })
    fireEvent.click(screen.getByTestId("transport-tile-remote"))
    expect(onTransportClick).toHaveBeenCalledWith("remote")
  })

  it("renders the native logging tile only when runtime is tauri", () => {
    const { rerender } = renderBar({
      nativeLogging: makeNativeLogging({
        runtime: "browser" as UseTransportHealthResult["nativeLogging"]["runtime"],
      }),
    })
    expect(screen.queryByTestId("transport-tile-native")).not.toBeInTheDocument()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelStatsBar
          {...defaultProps({
            nativeLogging: makeNativeLogging({ runtime: "tauri", status: "healthy" }),
          })}
        />
      </TooltipProvider>
    )
    expect(screen.getByTestId("transport-tile-native")).toBeInTheDocument()
  })

  it("clicking the native tile fires onNativeLoggingClick", () => {
    const onNativeLoggingClick = jest.fn()
    renderBar({
      nativeLogging: makeNativeLogging({ runtime: "tauri", status: "degraded" }),
      onNativeLoggingClick,
    })
    fireEvent.click(screen.getByTestId("transport-tile-native"))
    expect(onNativeLoggingClick).toHaveBeenCalledTimes(1)
  })

  it("applies the danger tone when transport is offline", () => {
    renderBar({
      healthByTransport: { remote: makeHealth({ transport: "remote", status: "offline" }) },
    })
    expect(screen.getByTestId("transport-tile-remote")).toHaveAttribute("data-tone", "danger")
  })

  it("renders +N overflow chip with localized aria-label", () => {
    const healthByTransport: Record<string, TransportHealthSnapshot> = {}
    for (const t of ["a", "b", "c", "d", "e"]) {
      healthByTransport[t] = makeHealth({ transport: t, queueDepth: 0 })
    }
    renderBar({ healthByTransport })
    const overflow = screen.getByTestId("transport-tile-overflow")
    expect(overflow.getAttribute("aria-label")).toMatch(/Show more transports/)
    expect(overflow).toHaveTextContent("+2")
  })

  it("shows formatted relative time (just now / 5m ago) for recent events", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-01-01T12:00:00Z"))
    renderBar({
      healthByTransport: {
        recent: makeHealth({
          transport: "recent",
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
      const { unmount } = renderBar({
        healthByTransport: {
          age: makeHealth({
            transport: "age",
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
    renderBar({
      healthByTransport: {
        none: makeHealth({
          transport: "none",
          lastSuccessAt: undefined,
          lastFailureAt: undefined,
          updatedAt: "not-a-date",
        }),
      },
    })
    expect(screen.getByTestId("transport-tile-none").textContent).toMatch(/—/)
  })

  it("renders inactive native tile when status is inactive (muted tone)", () => {
    renderBar({
      nativeLogging: makeNativeLogging({ runtime: "tauri", status: "inactive" }),
    })
    expect(screen.getByTestId("transport-tile-native")).toHaveAttribute("data-tone", "muted")
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
  it("renders status / mode / bridge / targets fields and reacts to close", () => {
    const onClose = jest.fn()
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging({
          runtime: "tauri",
          status: "healthy",
          startupMode: "spawn" as UseTransportHealthResult["nativeLogging"]["startupMode"],
          bridgeState: "connected" as UseTransportHealthResult["nativeLogging"]["bridgeState"],
          activeTargets: ["console", "file"],
        })}
        onClose={onClose}
        onViewDiagnostics={jest.fn()}
      />
    )
    expect(screen.getByText(/healthy/)).toBeInTheDocument()
    expect(screen.getByText(/spawn/)).toBeInTheDocument()
    expect(screen.getByText(/connected/)).toBeInTheDocument()
    expect(screen.getByText(/console, file/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the localized "none" placeholder when activeTargets is empty', () => {
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging({ activeTargets: [] })}
        onClose={jest.fn()}
        onViewDiagnostics={jest.fn()}
      />
    )
    // en.json maps logging.panel.nativeLoggingNoTargets → "none"
    expect(screen.getByText(/none/)).toBeInTheDocument()
  })

  it("renders fallback reason and bridge error when present", () => {
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging({
          fallbackReason: { message: "ipc-init failed" } as never,
          bridgeLastError: "EPIPE",
        })}
        onClose={jest.fn()}
        onViewDiagnostics={jest.fn()}
      />
    )
    expect(screen.getByText(/ipc-init failed/)).toBeInTheDocument()
    expect(screen.getByText(/EPIPE/)).toBeInTheDocument()
  })

  it("invokes onViewDiagnostics when its button is clicked", () => {
    const onViewDiagnostics = jest.fn()
    render(
      <NativeLoggingDetail
        nativeLogging={makeNativeLogging()}
        onClose={jest.fn()}
        onViewDiagnostics={onViewDiagnostics}
      />
    )
    fireEvent.click(screen.getByText("View Native Diagnostics"))
    expect(onViewDiagnostics).toHaveBeenCalledTimes(1)
  })
})
