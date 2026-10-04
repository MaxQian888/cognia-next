/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PerformanceCaptureRow } from "@/lib/perf/capture-types"

// Built inside the factory: the tab resolves the controller at module load,
// before any top-level `const` here is initialized (TDZ).
jest.mock("@/lib/perf/capture-controller", () => {
  const controller = {
    snapshot: {
      active: false,
      captureId: null,
      sourceKind: null,
      targetId: null,
      startedAt: null,
      gapCount: 0,
      error: null as string | null,
    },
    subscribe: () => () => undefined,
    start: jest.fn(async () => "capture-new"),
    stop: jest.fn(async () => {}),
  }
  return { getPerformanceCaptureController: () => controller }
})

let mockCaptures: PerformanceCaptureRow[] = []
jest.mock("dexie-react-hooks", () => ({
  // The library query has one dep; the raw-export attachment query has two.
  useLiveQuery: (_query: unknown, deps: unknown[], fallback: unknown) =>
    deps.length === 1 ? mockCaptures : fallback,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "db", performanceCaptures: {} }) }))

let mockAccountId: string | null = "account"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (value: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: mockAccountId }),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => null,
}))
jest.mock("@/lib/ai/eval/artifact-crypto", () => ({
  loadOrCreateAccountArtifactKey: jest.fn(async () => new Uint8Array(32)),
}))
const deleteMock = jest.fn(async (_input: unknown) => {})
jest.mock("@/lib/perf/capture-service", () => ({
  deletePerformanceCapture: (input: unknown) => deleteMock(input),
  PERFORMANCE_CAPTURE_DEFAULT_DURATION_MS: 600_000,
}))
jest.mock("@/lib/perf/quota", () => ({
  PerformanceQuotaManager: class {
    close() {}
  },
  PERFORMANCE_ACCOUNT_QUOTA_BYTES: 2 * 1024 * 1024 * 1024,
}))
jest.mock("@/lib/perf/budget-service", () => ({
  PerformanceBudgetService: class {
    async list() {
      return []
    }
    close() {}
  },
}))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { captureErrorCode, PerfCapturesTab } from "./perf-captures-tab"
import { getPerformanceCaptureController } from "@/lib/perf/capture-controller"

const mockController = getPerformanceCaptureController() as unknown as {
  snapshot: { error: string | null } & Record<string, unknown>
  start: jest.Mock
}

function row(overrides: Partial<PerformanceCaptureRow> = {}): PerformanceCaptureRow {
  return {
    id: "capture-1",
    status: "ready",
    purpose: "capture",
    sourceKind: "renderer",
    sourceId: "renderer:doc",
    hostInstanceId: "doc",
    targetId: "t",
    routingGeneration: 0,
    wireVersion: 1,
    metricSchemaVersion: 1,
    capabilityBits: "",
    startedAt: 0,
    updatedAt: 90_000,
    stoppedAt: 90_000,
    stopReason: "duration-limit",
    pinned: 0,
    payloadBytes: 2048,
    attachmentBytes: 0,
    frameCount: 90,
    gapCount: 2,
    trustState: "valid-untrusted",
    ...overrides,
  }
}

beforeEach(() => {
  mockCaptures = []
  mockAccountId = "account"
  mockController.snapshot = { ...mockController.snapshot, error: null }
  deleteMock.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  mockController.start.mockClear()
})

describe("PerfCapturesTab", () => {
  it("starts a renderer capture by default", async () => {
    render(<PerfCapturesTab hostAvailable={false} />)
    expect(screen.getByText("No captures are stored for this target.")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("perf-capture-start"))
    await waitFor(() =>
      expect(mockController.start).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKind: "renderer", cadenceMs: 1000 })
      )
    )
    expect(toastSuccess).toHaveBeenCalledWith("Capture started.")
  })

  it("says why Start is disabled while the account is locked", () => {
    mockAccountId = null
    render(<PerfCapturesTab hostAvailable />)
    expect(screen.getByTestId("perf-capture-start")).toBeDisabled()
    expect(screen.getByTestId("perf-capture-locked")).toBeInTheDocument()
    expect(screen.getByTestId("perf-budget-locked")).toBeInTheDocument()
  })

  it("shows translated status, stop reason, gaps and trust instead of enum strings", () => {
    mockCaptures = [row()]
    render(<PerfCapturesTab hostAvailable={false} />)
    const item = screen.getByTestId("perf-capture-capture-1")
    expect(item).toHaveTextContent("Ready")
    expect(item).toHaveTextContent("Duration reached")
    expect(item).toHaveTextContent("2 gaps")
    expect(item).toHaveTextContent("Valid, untrusted signer")
    expect(item).toHaveTextContent("2.0 KB")
    expect(item).not.toHaveTextContent("duration-limit")
  })

  it("deletes only after confirmation", async () => {
    mockCaptures = [row()]
    render(<PerfCapturesTab hostAvailable={false} />)
    fireEvent.click(screen.getByTestId("perf-capture-delete-capture-1"))
    expect(deleteMock).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("perf-capture-delete-confirm"))
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith(expect.objectContaining({ captureId: "capture-1" }))
    )
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Capture deleted."))
  })

  it("opens the comparison once two ready captures are ticked", () => {
    mockCaptures = [
      row(),
      row({ id: "capture-2", startedAt: 100 }),
      row({ id: "rec", status: "recording" }),
    ]
    render(<PerfCapturesTab hostAvailable={false} />)
    expect(screen.getByRole("checkbox", { name: /Select capture rec/ })).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", { name: /Select capture capture-1/ }))
    expect(screen.queryByTestId("perf-capture-compare")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: /Select capture capture-2/ }))
    expect(screen.getByTestId("perf-capture-compare")).toBeInTheDocument()
  })

  it("localizes a controller error code", () => {
    mockController.snapshot = {
      ...mockController.snapshot,
      error: "account-locked:account",
    }
    render(<PerfCapturesTab hostAvailable={false} />)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The account was locked, so the capture stopped."
    )
  })

  it("localizes a thrown error, falling back to its detail", async () => {
    mockController.start.mockRejectedValueOnce(new Error("performance-capture-already-active"))
    render(<PerfCapturesTab hostAvailable={false} />)
    fireEvent.click(screen.getByTestId("perf-capture-start"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("A capture is already recording."))
    mockController.start.mockRejectedValueOnce(new Error("disk on fire"))
    fireEvent.click(screen.getByTestId("perf-capture-start"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Something went wrong: disk on fire")
    )
  })
})

describe("captureErrorCode", () => {
  it("strips a suffix after the code", () => {
    expect(captureErrorCode(new Error("account-locked:abc"))).toBe("account-locked")
    expect(captureErrorCode("performance-quota-exceeded")).toBe("performance-quota-exceeded")
  })
})
