/**
 * Shell coverage for Settings → Observability → Logs: deep links, the nav, the
 * live badge, the save bar, and restore-defaults. Panel-local behaviour lives
 * in `panels/*.test.tsx` — this file owns how the pieces are wired together.
 */

let searchString = ""
const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(searchString),
  usePathname: () => "/settings",
}))

const applyLoggingSettings = jest.fn()
jest.mock("@/lib/logging", () => {
  const actual = jest.requireActual("@/lib/logging")
  return { ...actual, applyLoggingSettings: (...args: unknown[]) => applyLoggingSettings(...args) }
})

const saveAppSettings = jest.fn(async () => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof saveAppSettings }) => unknown) =>
    selector({ save: saveAppSettings }),
}))

let nativeLogging: NativeLoggingReadiness
let healthByTransport: Record<string, TransportHealthSnapshot>
jest.mock("@/hooks/logging", () => ({
  useTransportHealth: () => ({
    nativeLogging,
    healthByTransport,
    queueDepthHistoryByTransport: {},
    isLoading: false,
    error: null,
    refresh: jest.fn(),
  }),
}))

jest.mock("@/components/logging/native-log-viewer", () => ({
  NativeLogViewer: () => <div data-testid="native-log-viewer" />,
}))
jest.mock("@/components/logging/native-log-levels", () => ({
  NativeLogLevels: () => null,
}))

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import {
  DEFAULT_RETENTION_SETTINGS,
  DEFAULT_TRANSPORT_SETTINGS,
  LOGGING_SAMPLING_STORAGE_KEY,
} from "@/lib/logging"
import { DEFAULT_UNIFIED_CONFIG } from "@/types/logging"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

import { LOGS_NAV_ITEMS } from "./nav-config"
import { LogsSection } from "./logs-section"

function renderAt(panel = "", onClose?: () => void) {
  searchString = panel ? `logsPanel=${panel}` : ""
  return render(<LogsSection onClose={onClose} />)
}

beforeEach(() => {
  searchString = ""
  replace.mockClear()
  saveAppSettings.mockClear()
  window.localStorage.clear()
  nativeLogging = {
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
  }
  healthByTransport = {}
  applyLoggingSettings.mockReset()
  applyLoggingSettings.mockImplementation(
    (params: { config?: object; transports?: object; retention?: object }) => ({
      config: { ...DEFAULT_UNIFIED_CONFIG, ...(params.config ?? {}) },
      transports: { ...DEFAULT_TRANSPORT_SETTINGS, ...(params.transports ?? {}) },
      retention: { ...DEFAULT_RETENTION_SETTINGS, ...(params.retention ?? {}) },
    })
  )
})

describe("panel routing", () => {
  it("opens on the overview when no panel is deep-linked", () => {
    renderAt()
    expect(screen.getByTestId("logs-nav-item-overview")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("logs-overview-readiness")).toBeInTheDocument()
  })

  it.each(LOGS_NAV_ITEMS.map((item) => item.id))(
    "renders the %s panel from its deep link",
    (id) => {
      renderAt(id)
      expect(screen.getByTestId(`logs-nav-item-${id}`)).toHaveAttribute("aria-current", "true")
    }
  )

  it("falls back to the overview for an unknown panel value", () => {
    renderAt("nonsense")
    expect(screen.getByTestId("logs-nav-item-overview")).toHaveAttribute("aria-current", "true")
  })

  it("writes the chosen panel to the URL without scrolling the page", async () => {
    const user = userEvent.setup()
    renderAt("overview")

    await user.click(screen.getByTestId("logs-nav-item-transports"))

    expect(replace).toHaveBeenCalledWith("?logsPanel=transports", { scroll: false })
  })

  it("preserves the settings section parameter when switching panels", async () => {
    const user = userEvent.setup()
    searchString = "section=logs&logsPanel=overview"
    render(<LogsSection />)

    await user.click(screen.getByTestId("logs-nav-item-retention"))

    const [url] = replace.mock.calls[0] as [string]
    expect(url).toContain("section=logs")
    expect(url).toContain("logsPanel=retention")
  })

  it("titles the detail pane with the active panel", () => {
    renderAt("filters")
    const body = screen.getByTestId("logs-panel-body")
    expect(within(body).getByRole("heading", { name: "Filtering & redaction" })).toBeInTheDocument()
  })
})

describe("transport badge", () => {
  it("counts the enabled transports and tracks edits live", async () => {
    const user = userEvent.setup()
    renderAt("transports")

    const badge = screen.getByTestId("logs-nav-badge-transports")
    const before = Number(badge.textContent?.split("/")[0])

    await user.click(screen.getByRole("switch", { name: "Console Output" }))

    expect(screen.getByTestId("logs-nav-badge-transports")).toHaveTextContent(`${before - 1}/7`)
  })

  it("spells the badge out for screen readers", () => {
    renderAt("transports")
    expect(screen.getByTestId("logs-nav-badge-transports")).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/of 7 transports enabled/)
    )
  })
})

describe("save bar", () => {
  it("stays hidden while there is nothing to save", () => {
    renderAt("levels")
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
  })

  it("appears with a count once a field changes", async () => {
    const user = userEvent.setup()
    renderAt("levels")

    await user.click(screen.getByRole("switch", { name: /Include Stack Traces/i }))

    const bar = await screen.findByTestId("unsaved-bar")
    expect(bar).toHaveAttribute("data-status", "dirty")
    expect(bar).toHaveTextContent("1 unsaved change")
  })

  it("survives a panel switch, because the draft is one document", async () => {
    const user = userEvent.setup()
    renderAt("levels")

    await user.click(screen.getByRole("switch", { name: /Include Stack Traces/i }))
    await screen.findByTestId("unsaved-bar")

    searchString = "logsPanel=retention"
    await user.click(screen.getByTestId("logs-nav-item-retention"))

    expect(screen.getByTestId("unsaved-bar")).toHaveTextContent("1 unsaved change")
  })

  it("commits every edited store on save", async () => {
    const user = userEvent.setup()
    renderAt("levels")

    await user.click(screen.getByRole("switch", { name: /Include Stack Traces/i }))
    await user.click(await screen.findByTestId("unsaved-bar-save"))

    await waitFor(() => expect(applyLoggingSettings).toHaveBeenCalledTimes(1))
    const payload = applyLoggingSettings.mock.calls[0][0] as {
      config: { includeStackTrace: boolean }
    }
    expect(payload.config.includeStackTrace).toBe(false)
    // The behaviour-telemetry consent rides along in the same commit.
    expect(saveAppSettings).toHaveBeenCalled()
  })

  it("discards back to the saved values", async () => {
    const user = userEvent.setup()
    renderAt("levels")

    const toggle = screen.getByRole("switch", { name: /Include Stack Traces/i })
    await user.click(toggle)
    await user.click(await screen.findByTestId("unsaved-bar-discard"))

    await waitFor(() => expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument())
    expect(applyLoggingSettings).not.toHaveBeenCalled()
  })

  it("reports a failed save instead of silently swallowing it", async () => {
    applyLoggingSettings.mockImplementation(() => {
      throw new Error("boom")
    })
    const user = userEvent.setup()
    renderAt("levels")

    await user.click(screen.getByRole("switch", { name: /Include Stack Traces/i }))
    await user.click(await screen.findByTestId("unsaved-bar-save"))

    expect(await screen.findByRole("alert")).toHaveTextContent(/Failed to save/i)
  })
})

describe("restore defaults", () => {
  it("asks before replacing the form", async () => {
    const user = userEvent.setup()
    renderAt("levels")

    await user.click(screen.getByTestId("logs-restore-defaults"))

    expect(
      await screen.findByRole("alertdialog", { name: /Restore the default logging settings/i })
    ).toBeInTheDocument()
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
  })

  it("loads the defaults as an unsaved draft, not a committed change", async () => {
    const user = userEvent.setup()
    renderAt("filters")

    await user.click(screen.getByTestId("logs-restore-defaults"))
    await user.click(await screen.findByTestId("logs-restore-defaults-confirm"))

    // Nothing has been applied or persisted — the save bar is the commit.
    expect(applyLoggingSettings).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(LOGGING_SAMPLING_STORAGE_KEY)).toBeNull()
  })

  it("leaves the form untouched when the dialog is cancelled", async () => {
    const user = userEvent.setup()
    renderAt("levels")

    await user.click(screen.getByTestId("logs-restore-defaults"))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument())
  })
})

describe("mobile nav", () => {
  it("offers the rail behind a sheet, with the active panel named beside it", async () => {
    const user = userEvent.setup()
    renderAt("transports")

    expect(screen.getByTestId("logs-mobile-nav-trigger")).toBeInTheDocument()
    await user.click(screen.getByTestId("logs-mobile-nav-trigger"))

    // Distinct id prefix: the desktop rail is only `display:none` below `md`,
    // so both copies are mounted while the sheet is open.
    expect(await screen.findByTestId("logs-sheet-nav-item-levels")).toBeInTheDocument()
    expect(screen.getByTestId("logs-nav-item-levels")).toBeInTheDocument()
  })
})

describe("overview", () => {
  it("passes the host-dialog dismissal down to the /logs link", async () => {
    const user = userEvent.setup()
    const onClose = jest.fn()
    renderAt("overview", onClose)

    await user.click(screen.getByRole("link", { name: /Open Log Panel/i }))

    expect(onClose).toHaveBeenCalled()
  })

  it("renders the live transport health the section polls once for", () => {
    healthByTransport = {
      console: {
        transport: "console",
        status: "healthy",
        queueDepth: 3,
        retryCount: 0,
        droppedEntries: 0,
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    }
    renderAt("overview")
    expect(screen.getByTestId("logs-transport-health-console")).toHaveTextContent("queue 3")
  })
})
