/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { PERF_WIRE_VERSION } from "@/lib/perf/backend/types"
import { PerfSourceHealth } from "./perf-source-health"

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
