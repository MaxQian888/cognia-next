/**
 * Covers the two things the pre-redesign transports tab could not show: which
 * transports are actually healthy, and which settings belong to which sink —
 * the remote retry-queue bounds used to live three screens away in `Advanced`.
 */

const saveAppSettings = jest.fn(async () => undefined)
const getLangfuseCredentialsStatus = jest.fn(async () => {
  throw new Error("Host unavailable")
})
const testLangfuseConnection = jest.fn(async () => ({ connected: true, status: 200 }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof saveAppSettings }) => unknown) =>
    selector({ save: saveAppSettings }),
}))
jest.mock("@/lib/logging/langfuse-host", () => ({
  clearLangfuseCredentials: jest.fn(async () => undefined),
  setLangfuseCredentials: jest.fn(async () => undefined),
  getLangfuseCredentialsStatus: () => getLangfuseCredentialsStatus(),
  testLangfuseConnection: () => testLangfuseConnection(),
}))
jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => true) }))

import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import { CONFIG_BOUNDS } from "@/lib/logging"
import { isTauri } from "@/lib/platform/detect"
import {
  TRANSPORT_KEYS,
  useLogSettingsDraft,
  type TransportKey,
} from "@/hooks/logging/use-log-settings-draft"

import { LogsTransportsPanel } from "./transports-panel"

const mockIsTauri = jest.mocked(isTauri)
let draft: ReturnType<typeof useLogSettingsDraft>

function snapshot(
  transport: string,
  status: TransportHealthSnapshot["status"] = "healthy"
): TransportHealthSnapshot {
  return {
    transport,
    status,
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    updatedAt: "2026-08-19T00:00:00.000Z",
  }
}

function Harness({
  healthByTransport = {},
  openAll = true,
}: {
  healthByTransport?: Record<string, TransportHealthSnapshot>
  openAll?: boolean
}) {
  const value = useLogSettingsDraft()
  // Captured in an effect, not during render: assigning to an outer binding
  // while rendering is a side effect the React compiler lint rejects.
  useEffect(() => {
    draft = value
  })
  return (
    <LogsTransportsPanel
      draft={value}
      healthByTransport={healthByTransport}
      expanded={
        Object.fromEntries(TRANSPORT_KEYS.map((key) => [key, openAll])) as Record<
          TransportKey,
          boolean
        >
      }
      onExpandedChange={jest.fn()}
    />
  )
}

beforeEach(() => {
  window.localStorage.clear()
  getLangfuseCredentialsStatus.mockClear()
  testLangfuseConnection.mockClear()
  mockIsTauri.mockReturnValue(true)
})

describe("LogsTransportsPanel", () => {
  it("renders a row for every transport the settings can toggle", () => {
    render(<Harness />)
    for (const key of TRANSPORT_KEYS) {
      expect(screen.getByTestId(`logs-transport-${key}`)).toBeInTheDocument()
    }
  })

  it("maps each row to the transport name the logger registers under", () => {
    // The settings key and the registered transport name differ for four of
    // them (indexedDB/indexeddb, agentTrace/agent-trace, …); a wrong mapping
    // would silently show no badge.
    render(
      <Harness
        healthByTransport={{
          console: snapshot("console"),
          indexeddb: snapshot("indexeddb"),
          native: snapshot("native", "offline"),
          remote: snapshot("remote", "degraded"),
          langfuse: snapshot("langfuse"),
          "agent-trace": snapshot("agent-trace"),
          "agent-trace-otlp": snapshot("agent-trace-otlp", "offline"),
          "otlp-logs": snapshot("otlp-logs", "healthy"),
        }}
      />
    )

    expect(screen.getByTestId("logs-transport-health-badge-indexedDB")).toHaveTextContent("healthy")
    expect(screen.getByTestId("logs-transport-health-badge-agentTrace")).toHaveTextContent(
      "healthy"
    )
    expect(screen.getByTestId("logs-transport-health-badge-remote")).toHaveTextContent("degraded")
    expect(screen.getByTestId("logs-transport-health-badge-agentTraceOtlp")).toHaveTextContent(
      "offline"
    )
    expect(screen.getByTestId("logs-transport-health-badge-otlpLogs")).toHaveTextContent("healthy")
  })

  it("toggles a transport in the draft", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("switch", { name: "Console Output" }))

    expect(draft.transports.console).toBe(false)
  })

  it("warns that an endpoint-less remote transport stays detached", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const row = screen.getByTestId("logs-transport-remote")
    expect(within(row).getByText(/stays detached/i)).toBeInTheDocument()

    await user.type(screen.getByLabelText("Endpoint URL"), "https://logs.example.com")

    expect(draft.transports.remoteConfig.endpoint).toBe("https://logs.example.com")
    expect(within(row).queryByText(/stays detached/i)).not.toBeInTheDocument()
  })

  it("keeps the remote retry-queue bounds inside the remote transport", async () => {
    render(<Harness />)
    const row = screen.getByTestId("logs-transport-remote")
    const entriesBefore = draft.config.remoteQueueMaxEntries
    const bytesBefore = draft.config.remoteQueueMaxBytes

    const entries = within(row).getByRole("slider", { name: /Remote Queue Entries/i })
    entries.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(draft.config.remoteQueueMaxEntries).toBeGreaterThan(entriesBefore)

    const bytes = within(row).getByRole("slider", { name: /Remote Queue Size/i })
    bytes.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(draft.config.remoteQueueMaxBytes).toBeGreaterThan(bytesBefore)
  })

  it("offers the full range the sanitizer accepts, not a narrower one", () => {
    // A slider that stopped short of the real ceiling silently snapped a
    // higher stored value down the first time the control was touched.
    render(<Harness />)
    const row = screen.getByTestId("logs-transport-remote")

    const entries = within(row).getByRole("slider", { name: /Remote Queue Entries/i })
    expect(entries).toHaveAttribute(
      "aria-valuemin",
      String(CONFIG_BOUNDS.remoteQueueMaxEntries.min)
    )
    expect(entries).toHaveAttribute(
      "aria-valuemax",
      String(CONFIG_BOUNDS.remoteQueueMaxEntries.max)
    )

    const bytes = within(row).getByRole("slider", { name: /Remote Queue Size/i })
    expect(bytes).toHaveAttribute(
      "aria-valuemax",
      String(CONFIG_BOUNDS.remoteQueueMaxBytes.max / (1024 * 1024))
    )
  })

  it("exposes the IndexedDB write-batching knobs the transport consumes", async () => {
    render(<Harness />)
    const row = screen.getByTestId("logs-transport-indexedDB")

    // Both were persisted but never reached the transport, so neither had a
    // control: there was nothing to point at.
    const buffer = within(row).getByRole("slider", { name: /Buffer Size/i })
    expect(buffer).toHaveAttribute("aria-valuemin", String(CONFIG_BOUNDS.bufferSize.min))
    expect(buffer).toHaveAttribute("aria-valuemax", String(CONFIG_BOUNDS.bufferSize.max))

    const bufferBefore = draft.config.bufferSize
    buffer.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(draft.config.bufferSize).toBeGreaterThan(bufferBefore)

    const flush = within(row).getByRole("slider", { name: /Flush Interval/i })
    const flushBefore = draft.config.flushInterval
    flush.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(draft.config.flushInterval).toBe(flushBefore + 250)
  })

  it("writes the Langfuse secret to the write-only draft, never into the settings", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("Secret Key"), "sk-live-abc")

    expect(draft.secretDrafts.langfuseSecretKey).toBe("sk-live-abc")
    expect(JSON.stringify(draft.transports.langfuseConfig)).not.toContain("sk-live-abc")
  })

  it("keeps Langfuse model and tool content consent independent", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const model = screen.getByRole("switch", { name: "Capture model content" })
    const tool = screen.getByRole("switch", { name: "Capture tool content" })
    expect(model).not.toBeChecked()
    expect(tool).not.toBeChecked()

    await user.click(tool)

    expect(draft.transports.langfuseConfig.captureModelContent).toBe(false)
    expect(draft.transports.langfuseConfig.captureToolContent).toBe(true)
  })

  it("tests the account Host connection from the Langfuse panel", async () => {
    getLangfuseCredentialsStatus.mockResolvedValueOnce({
      configured: true,
      enabled: true,
      baseUrl: "https://langfuse.example",
      publicKey: "pk-account",
      environment: "test",
      captureModelContent: false,
      captureToolContent: false,
    })
    const user = userEvent.setup()
    render(<Harness />)

    const button = await screen.findByRole("button", { name: "Test connection" })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    expect(testLangfuseConnection).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole("status")).toHaveTextContent("Connection succeeded.")
  })

  it("swaps the OTLP credential fields for the Grafana Cloud preset", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("agent-trace-otlp-preset"))
    await user.click(screen.getByRole("option", { name: /Grafana Cloud/i }))

    expect(screen.getByTestId("agent-trace-otlp-grafana-instance-id")).toBeInTheDocument()
    expect(screen.getByTestId("agent-trace-otlp-grafana-api-token")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-trace-otlp-headers")).not.toBeInTheDocument()
  })

  it("keeps OTLP authentication at the Host or Collector boundary", () => {
    render(<Harness />)

    act(() => {
      draft.setTransportDetail("agentTraceOtlpConfig", "preset", "self-hosted")
    })

    expect(screen.queryByTestId("agent-trace-otlp-headers")).not.toBeInTheDocument()
    expect(screen.getByText(/configure authentication on the Host or Collector/i)).toBeVisible()
  })

  it("does not expose Grafana credentials without the secure desktop Host", () => {
    mockIsTauri.mockReturnValue(false)
    render(<Harness />)

    act(() => {
      draft.setTransportDetail("agentTraceOtlpConfig", "preset", "grafana-cloud")
    })

    expect(screen.queryByTestId("agent-trace-otlp-grafana-instance-id")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-trace-otlp-grafana-api-token")).not.toBeInTheDocument()
    expect(screen.getByText(/require the secure desktop Host/i)).toBeVisible()
  })

  it("edits the agent-trace capture and retention settings", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("agent-trace-capture-content-switch"))
    expect(draft.transports.agentTraceConfig.captureContent).toBe(true)

    const retention = screen.getByTestId("agent-trace-retention-slider")
    within(retention).getByRole("slider").focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(draft.transports.agentTraceConfig.retentionDays).toBe(8)
  })

  it("hides every configuration body while the rows are collapsed", () => {
    render(<Harness openAll={false} />)
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Console Output" })).toBeInTheDocument()
  })
})
