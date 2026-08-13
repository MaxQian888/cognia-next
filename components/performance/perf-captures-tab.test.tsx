/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/perf/capture-controller", () => {
  const controller = {
    snapshot: {
      active: false,
      captureId: null,
      sourceKind: null,
      targetId: null,
      startedAt: null,
      gapCount: 0,
      error: null,
    },
    subscribe: (listener: (value: unknown) => void) => {
      listener({
        active: false,
        captureId: null,
        sourceKind: null,
        targetId: null,
        startedAt: null,
        gapCount: 0,
        error: null,
      })
      return () => undefined
    },
    start: jest.fn(),
    stop: jest.fn(),
  }
  return { getPerformanceCaptureController: () => controller }
})
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "db", performanceCaptures: {} }) }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (value: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "account" }),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => null,
}))

import { PerfCapturesTab } from "./perf-captures-tab"
import { getPerformanceCaptureController } from "@/lib/perf/capture-controller"

it("renders progressive renderer capture controls and disables unavailable host", async () => {
  render(<PerfCapturesTab hostAvailable={false} />)
  expect(screen.getByTestId("perf-captures-tab")).toBeInTheDocument()
  expect(screen.getByText("No captures are stored for this target.")).toBeInTheDocument()
  fireEvent.click(screen.getByText("Start capture"))
  await waitFor(() =>
    expect(getPerformanceCaptureController().start).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: "renderer" })
    )
  )
})
