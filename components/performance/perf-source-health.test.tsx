/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { PERF_WIRE_VERSION, type PerfSourceDescriptor } from "@/lib/perf/backend/types"
import { PerfSourceHealth } from "./perf-source-health"

const hostSource: PerfSourceDescriptor = {
  wireVersion: PERF_WIRE_VERSION,
  sourceId: "host:one",
  kind: "host",
  hostInstanceId: "boot",
  runtimeKind: "tauri-rust",
  build: { version: "test", commit: null, profile: "development" },
  metricSchemaVersion: 1,
  capabilities: ["host.processes"],
  clock: { kind: "host-monotonic", originWallMs: 0 },
  connection: { state: "live", changedAtMs: 0, detail: null },
}

it("renders explicit source, capability, overhead, error, and gap states", () => {
  render(
    <PerfSourceHealth
      sources={[
        {
          wireVersion: PERF_WIRE_VERSION,
          sourceId: "renderer:one",
          kind: "renderer",
          hostInstanceId: "doc",
          runtimeKind: "browser",
          build: { version: "test", commit: null, profile: "development" },
          metricSchemaVersion: 1,
          capabilities: ["renderer.fps"],
          clock: { kind: "performance-time-origin", originWallMs: 0 },
          connection: { state: "live", changedAtMs: 0, detail: null },
        },
      ]}
      hostState="unsupported"
      gaps={[
        {
          reason: "sequence-gap",
          sourceId: "renderer:one",
          samplingSessionId: "s",
          sequenceStart: 2,
          sequenceEnd: 3,
          wallStartMs: 100,
          wallEndMs: 200,
          recoverable: false,
          clockUncertaintyMs: 10,
          detail: null,
        },
      ]}
      error="permission-denied"
      collectionDurationMs={5}
      actualIntervalMs={1000}
    />
  )
  expect(screen.getByTestId("perf-source-health")).toHaveTextContent("renderer.fps")
  expect(screen.getByTestId("perf-source-health")).toHaveTextContent("0.50%")
  expect(screen.getByTestId("perf-source-health")).toHaveTextContent("permission-denied")
  expect(screen.getByRole("status")).toBeInTheDocument()
})

describe("typed host issues", () => {
  it("explains a lease held by another window as a wait, not as the latest error", () => {
    render(
      <PerfSourceHealth
        sources={[hostSource]}
        hostState="connecting"
        gaps={[]}
        error="device already owns a lease for this purpose"
        issue={{
          kind: "contended",
          code: "device-purpose-limit",
          detail: "device already owns a lease for this purpose",
        }}
      />
    )
    expect(screen.getByTestId("perf-source-health-contended")).toHaveTextContent(
      "Another window on this device is already streaming host metrics"
    )
    expect(screen.getByTestId("perf-source-health-error")).toHaveTextContent("None")
    expect(screen.queryByText(/device-purpose-limit/)).not.toBeInTheDocument()
  })

  it("names a refusal retrying cannot fix in the reader's language", () => {
    render(
      <PerfSourceHealth
        sources={[hostSource]}
        hostState="error"
        gaps={[]}
        error="requested cadence is below the admitted minimum"
        issue={{
          kind: "rejected",
          code: "cadence-too-fast",
          detail: "requested cadence is below the admitted minimum",
        }}
      />
    )
    const cell = screen.getByTestId("perf-source-health-error")
    expect(cell).toHaveTextContent("The host refused the metrics stream (cadence-too-fast).")
    expect(cell).toHaveAttribute(
      "title",
      "Host said: requested cadence is below the admitted minimum"
    )
    expect(screen.queryByTestId("perf-source-health-contended")).not.toBeInTheDocument()
  })

  it("says the stream stopped renewing without printing the transport's words", () => {
    render(
      <PerfSourceHealth
        sources={[hostSource]}
        hostState="stale"
        gaps={[]}
        error="transport closed"
        issue={{ kind: "renew-failed", detail: "transport closed" }}
      />
    )
    expect(screen.getByTestId("perf-source-health-error")).toHaveTextContent(
      "The metrics stream stopped renewing."
    )
  })
})
