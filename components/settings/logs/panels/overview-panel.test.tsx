/**
 * The overview panel is read-only, so its whole job is not lying: every value
 * it shows comes from `useTransportHealth`, and a transport the logger never
 * registered must not appear at all.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/settings",
}))

jest.mock("@/components/logging/native-log-viewer", () => ({
  NativeLogViewer: () => <div data-testid="native-log-viewer" />,
}))

import { render, screen } from "@testing-library/react"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

import { LogsOverviewPanel, toneForNativeStatus, toneForTransportStatus } from "./overview-panel"

function readiness(overrides: Partial<NativeLoggingReadiness> = {}): NativeLoggingReadiness {
  return {
    runtime: "web",
    status: "inactive",
    startupMode: "disabled",
    startupHealth: "inactive",
    activeTargets: [],
    bridgeState: "inactive",
    platformLogging: {
      available: false,
      backend: "none",
      health: "inactive",
      enabled: true,
      minLevel: "warn",
    },
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  }
}

function snapshot(overrides: Partial<TransportHealthSnapshot> = {}): TransportHealthSnapshot {
  return {
    transport: "console",
    status: "healthy",
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  }
}

function renderPanel(
  nativeLogging = readiness(),
  healthByTransport: Record<string, TransportHealthSnapshot> = {},
  onNavigateAway?: () => void
) {
  return render(
    <LogsOverviewPanel
      nativeLogging={nativeLogging}
      healthByTransport={healthByTransport}
      onNavigateAway={onNavigateAway}
    />
  )
}

describe("tone mapping", () => {
  it("maps native readiness onto the three tones the panel paints", () => {
    expect(toneForNativeStatus("healthy")).toBe("success")
    expect(toneForNativeStatus("degraded")).toBe("warning")
    expect(toneForNativeStatus("inactive")).toBe("muted")
  })

  it("reads an offline transport as muted, not alarming", () => {
    // `offline` also covers "not applicable in this runtime" — the native and
    // breadcrumb transports on web — so red would be wrong.
    expect(toneForTransportStatus("healthy")).toBe("success")
    expect(toneForTransportStatus("degraded")).toBe("warning")
    expect(toneForTransportStatus("offline")).toBe("muted")
  })
})

describe("LogsOverviewPanel", () => {
  it("surfaces the readiness facts as a labelled grid", () => {
    renderPanel(
      readiness({
        status: "healthy",
        startupMode: "full",
        bridgeState: "active",
        activeTargets: ["cognia-structured.log", "stderr"],
        platformLogging: {
          available: true,
          backend: "oslog",
          health: "healthy",
          enabled: true,
          minLevel: "warn",
        },
      })
    )

    const block = screen.getByTestId("logs-overview-readiness")
    expect(block).toHaveTextContent("full")
    expect(block).toHaveTextContent("active")
    expect(block).toHaveTextContent("oslog")
    expect(block).toHaveTextContent("cognia-structured.log, stderr")
  })

  it("says so when the bridge is writing nowhere", () => {
    renderPanel(readiness({ activeTargets: [] }))
    expect(screen.getByTestId("logs-overview-readiness")).toHaveTextContent("none")
  })

  it("lists every problem the readiness snapshot carries", () => {
    renderPanel(
      readiness({
        status: "degraded",
        fallbackReason: { code: "init-failed", message: "tracing init failed" },
        platformLogging: {
          available: false,
          backend: "none",
          health: "degraded",
          enabled: true,
          minLevel: "warn",
          error: "os_log unavailable",
        },
        bridgeLastError: "channel closed",
      })
    )

    const problems = screen.getByTestId("logs-overview-problems")
    expect(problems).toHaveTextContent("tracing init failed")
    expect(problems).toHaveTextContent("os_log unavailable")
    expect(problems).toHaveTextContent("channel closed")
  })

  it("hides the problem list when there is nothing wrong", () => {
    renderPanel(readiness({ status: "healthy" }))
    expect(screen.queryByTestId("logs-overview-problems")).not.toBeInTheDocument()
  })

  it("renders one row per registered transport, sorted", () => {
    renderPanel(readiness(), {
      remote: snapshot({ transport: "remote", status: "degraded", queueDepth: 12 }),
      console: snapshot({ transport: "console" }),
    })

    const rows = screen.getAllByTestId(/^logs-transport-health-/)
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "logs-transport-health-console",
      "logs-transport-health-remote",
    ])
    expect(rows[1]).toHaveTextContent("degraded")
    expect(rows[1]).toHaveTextContent("queue 12")
  })

  it("mentions dropped entries only when some were dropped", () => {
    renderPanel(readiness(), {
      remote: snapshot({ transport: "remote", droppedEntries: 7 }),
      console: snapshot({ transport: "console" }),
    })

    expect(screen.getByTestId("logs-transport-health-remote")).toHaveTextContent("dropped 7")
    expect(screen.getByTestId("logs-transport-health-console")).not.toHaveTextContent("dropped")
  })

  it("says nothing has reported rather than inventing rows", () => {
    renderPanel()
    expect(screen.getByTestId("logs-overview-transport-health")).toHaveTextContent(
      "No transports have reported health yet."
    )
  })

  it("links to the full log panel and dismisses the host dialog on the way", () => {
    const onNavigateAway = jest.fn()
    renderPanel(readiness(), {}, onNavigateAway)

    const link = screen.getByRole("link", { name: /Open Log Panel/i })
    expect(link).toHaveAttribute("href", "/logs")

    link.click()
    expect(onNavigateAway).toHaveBeenCalled()
  })

  it("embeds the on-disk log file viewer", async () => {
    renderPanel()
    // The block ships collapsed — reading files is a deliberate action, not
    // something the overview does on every open.
    const trigger = screen.getByRole("button", { name: /Native log files/i })
    trigger.click()
    expect(await screen.findByTestId("native-log-viewer")).toBeInTheDocument()
  })
})
