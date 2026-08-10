/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ExportMenu } from "./export-menu"
import {
  DASHBOARD_CONFIG_VERSION,
  type DashboardConfig,
} from "@/lib/observability/dashboard-config"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars)[0]}` : key,
}))

const mockSaveExport = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (opts: unknown) => mockSaveExport(opts),
}))

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToast.success(...a),
    error: (...a: unknown[]) => mockToast.error(...a),
    info: (...a: unknown[]) => mockToast.info(...a),
  },
}))

// Flatten the Radix dropdown so items render without a portal (repo pattern),
// forwarding data-testid so we can target the entries.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
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
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const config: DashboardConfig = {
  version: DASHBOARD_CONFIG_VERSION,
  layouts: null,
  hiddenPanels: [],
  thresholds: {},
  rangePreset: "1h",
  customSince: null,
  customUntil: null,
  refreshMs: 10_000,
  filters: {},
}

const traces: TraceRollupRow[] = [
  {
    traceId: "t1",
    rootName: "chat",
    startTime: 0,
    durationMs: 10,
    spanCount: 1,
    errorCount: 0,
    totalCostUsd: 0.1,
    surface: "chat",
  },
]

function setup(props: Partial<React.ComponentProps<typeof ExportMenu>> = {}) {
  const onImportConfig = jest.fn()
  render(
    <ExportMenu
      traces={traces}
      buildConfig={() => config}
      onImportConfig={onImportConfig}
      {...props}
    />
  )
  return { onImportConfig }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSaveExport.mockResolvedValue({ kind: "saved", location: "downloads" })
})

describe("ExportMenu", () => {
  it("exports traces as CSV", async () => {
    setup()
    fireEvent.click(screen.getByTestId("export-traces-csv"))
    await waitFor(() => expect(mockSaveExport).toHaveBeenCalled())
    const opts = mockSaveExport.mock.calls[0][0]
    expect(opts.mimeType).toBe("text/csv")
    expect(opts.filename).toMatch(/\.csv$/)
    expect(opts.data).toContain("traceId,")
    expect(mockToast.success).toHaveBeenCalled()
  })

  it("skips CSV export and informs when there are no traces", async () => {
    setup({ traces: [] })
    fireEvent.click(screen.getByTestId("export-traces-csv"))
    expect(mockToast.info).toHaveBeenCalled()
    expect(mockSaveExport).not.toHaveBeenCalled()
  })

  it("exports the dashboard config as JSON", async () => {
    setup()
    fireEvent.click(screen.getByTestId("export-dashboard-json"))
    await waitFor(() => expect(mockSaveExport).toHaveBeenCalled())
    expect(mockSaveExport.mock.calls[0][0].mimeType).toBe("application/json")
  })

  it("surfaces a save error", async () => {
    mockSaveExport.mockResolvedValue({ kind: "error", message: "disk full" })
    setup()
    fireEvent.click(screen.getByTestId("export-dashboard-json"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled())
  })

  // jsdom here doesn't implement File.prototype.text(); production webviews do.
  // Provide a text()-capable stand-in matching what the handler reads.
  const fileWithText = (contents: string) =>
    ({ name: "dash.json", text: () => Promise.resolve(contents) }) as unknown as File

  it("imports a valid config file", async () => {
    const { onImportConfig } = setup()
    const file = fileWithText(JSON.stringify(config))
    fireEvent.change(screen.getByTestId("import-file-input"), { target: { files: [file] } })
    await waitFor(() => expect(onImportConfig).toHaveBeenCalled())
    expect(mockToast.success).toHaveBeenCalled()
  })

  it("rejects an invalid config file", async () => {
    const { onImportConfig } = setup()
    const file = fileWithText("{not json")
    fireEvent.change(screen.getByTestId("import-file-input"), { target: { files: [file] } })
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled())
    expect(onImportConfig).not.toHaveBeenCalled()
  })

  it("no-ops when no file is chosen", () => {
    const { onImportConfig } = setup()
    fireEvent.change(screen.getByTestId("import-file-input"), { target: { files: [] } })
    expect(onImportConfig).not.toHaveBeenCalled()
  })
})
