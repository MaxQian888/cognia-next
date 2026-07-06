/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ObservabilitySettingsSheet } from "./observability-settings-sheet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const controls = {
  thresholds: {},
  hiddenPanels: [] as string[],
  rangePreset: "1h" as const,
  refreshMs: 10_000 as const,
  setThreshold: jest.fn(),
  resetThresholds: jest.fn(),
  togglePanelVisibility: jest.fn(),
  setRangePreset: jest.fn(),
  setRefreshMs: jest.fn(),
}
jest.mock("@/hooks/observability/use-observability-controls", () => ({
  useObservabilityControls: () => controls,
}))

jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => 42,
}))

const mockPrune = jest.fn()
const mockClear = jest.fn()
jest.mock("@/lib/db/agent-traces", () => ({
  countAllSpans: jest.fn(),
  pruneOlderThan: (ms: number) => mockPrune(ms),
  clearAllSpans: () => mockClear(),
}))

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToast.success(...a),
    error: (...a: unknown[]) => mockToast.error(...a),
    info: (...a: unknown[]) => mockToast.info(...a),
  },
}))

// Flatten the portalling Radix wrappers so content renders inline.
jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
    "data-testid": testId,
  }: {
    children: React.ReactNode
    onClick?: () => void
    "data-testid"?: string
  }) => (
    <button onClick={onClick} data-testid={testId}>
      {children}
    </button>
  ),
}))

beforeEach(() => jest.clearAllMocks())

function open() {
  render(<ObservabilitySettingsSheet open onOpenChange={jest.fn()} />)
}

describe("ObservabilitySettingsSheet", () => {
  it("renders nothing when closed", () => {
    render(<ObservabilitySettingsSheet open={false} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("observability-settings")).not.toBeInTheDocument()
  })

  it("renders the sections when open", () => {
    open()
    expect(screen.getByTestId("observability-settings")).toBeInTheDocument()
    expect(screen.getByTestId("threshold-cost-warn")).toBeInTheDocument()
    expect(screen.getByTestId("panel-visibility-kpi-cost")).toBeInTheDocument()
  })

  it("edits a threshold bound while keeping the other bound", () => {
    open()
    fireEvent.change(screen.getByTestId("threshold-cost-warn"), { target: { value: "7" } })
    // cost defaults are warn 5 / crit 20 → warn becomes 7, crit preserved.
    expect(controls.setThreshold).toHaveBeenCalledWith("cost", { warn: 7, crit: 20 })
  })

  it("ignores a non-numeric threshold entry", () => {
    open()
    fireEvent.change(screen.getByTestId("threshold-cost-warn"), { target: { value: "" } })
    expect(controls.setThreshold).not.toHaveBeenCalled()
  })

  it("resets thresholds", () => {
    open()
    fireEvent.click(screen.getByTestId("thresholds-reset"))
    expect(controls.resetThresholds).toHaveBeenCalled()
  })

  it("toggles a panel's visibility", () => {
    open()
    fireEvent.click(screen.getByTestId("panel-visibility-ts-cost"))
    expect(controls.togglePanelVisibility).toHaveBeenCalledWith("ts-cost")
  })

  it("prunes old telemetry and reports", async () => {
    mockPrune.mockResolvedValue(3)
    open()
    fireEvent.click(screen.getByTestId("prune-button"))
    await waitFor(() => expect(mockPrune).toHaveBeenCalled())
    expect(mockToast.success).toHaveBeenCalled()
  })

  it("clears all telemetry after confirming", async () => {
    mockClear.mockResolvedValue(5)
    open()
    fireEvent.click(screen.getByTestId("clear-all-confirm"))
    await waitFor(() => expect(mockClear).toHaveBeenCalled())
    expect(mockToast.success).toHaveBeenCalled()
  })
})
