/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ScanStep } from "./scan-step"
import { EMPTY_SCAN, type ScanPhase, type ScanResult } from "@/lib/onboarding/scan"
import type { HistoryImport } from "@/hooks/onboarding/use-history-import"
import type { MachineScan } from "@/hooks/onboarding/use-machine-scan"

const scanOf = (phase: ScanPhase, result: Partial<ScanResult> = {}): MachineScan => ({
  phase,
  result: { ...EMPTY_SCAN, ...result },
  rescan: jest.fn(),
})

const historyOf = (over: Partial<HistoryImport> = {}): HistoryImport => ({
  phase: "idle",
  total: 0,
  sources: [],
  imported: 0,
  progress: 0,
  partial: false,
  importAll: jest.fn(),
  ...over,
})

describe("ScanStep", () => {
  it("shows the scanning state while probing", () => {
    render(
      <ScanStep
        shell="tauri"
        scan={scanOf("scanning")}
        history={historyOf()}
        onImport={jest.fn()}
        onImportHistory={jest.fn()}
      />
    )
    expect(screen.getByTestId("onboarding-scan-scanning")).toBeInTheDocument()
  })

  it("offers a rescan rather than only a dead end when empty", () => {
    const scan = scanOf("empty")
    render(
      <ScanStep
        shell="tauri"
        scan={scan}
        history={historyOf()}
        onImport={jest.fn()}
        onImportHistory={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-scan-rescan"))
    expect(scan.rescan).toHaveBeenCalled()
  })

  it("lists found runtimes and whether each is already signed in", () => {
    const scan = scanOf("found", {
      runtimes: [{ id: "claude-code", label: "Claude Code", authenticated: true }],
    })
    render(
      <ScanStep
        shell="tauri"
        scan={scan}
        history={historyOf()}
        onImport={jest.fn()}
        onImportHistory={jest.fn()}
      />
    )
    expect(screen.getByTestId("onboarding-runtime-claude-code")).toHaveTextContent("Claude Code")
    expect(screen.getByText("scan.authenticated")).toBeInTheDocument()
  })

  it("runs the import inline instead of sending the user to Settings", async () => {
    const onImport = jest.fn().mockResolvedValue(undefined)
    const scan = scanOf("found", { migratable: [{ vendor: "claude-code", installed: true }] })
    render(
      <ScanStep
        shell="tauri"
        scan={scan}
        history={historyOf()}
        onImport={onImport}
        onImportHistory={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-migrate-cta-claude-code"))
    await waitFor(() => expect(onImport).toHaveBeenCalledWith("claude-code"))
    await waitFor(() => expect(screen.getByText("scan.migrateDone")).toBeInTheDocument())
  })

  it("surfaces an import failure inline without blocking the flow", async () => {
    const onImport = jest.fn().mockRejectedValue(new Error("nope"))
    const scan = scanOf("found", { migratable: [{ vendor: "codex", installed: true }] })
    render(
      <ScanStep
        shell="tauri"
        scan={scan}
        history={historyOf()}
        onImport={onImport}
        onImportHistory={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-migrate-cta-codex"))
    await waitFor(() => expect(screen.getByText("scan.migrateFailed")).toBeInTheDocument())
  })

  it("replaces the body with pairing on a paired phone", () => {
    const onOpenPairing = jest.fn()
    render(
      <ScanStep
        shell="mobile-paired"
        scan={scanOf("empty")}
        history={historyOf({ phase: "found", total: 4 })}
        onImport={jest.fn()}
        onImportHistory={jest.fn()}
        onOpenPairing={onOpenPairing}
      />
    )
    // There is no local runtime to find — the compute lives on the desktop.
    expect(screen.queryByTestId("onboarding-scan")).toBeNull()
    // …and therefore no local transcripts either, even if the hook reported some.
    expect(screen.queryByTestId("onboarding-history")).toBeNull()
    fireEvent.click(screen.getByTestId("onboarding-open-pairing"))
    expect(onOpenPairing).toHaveBeenCalled()
  })

  describe("chat history", () => {
    const renderWith = (history: HistoryImport, onImportHistory = jest.fn()) => {
      render(
        <ScanStep
          shell="tauri"
          scan={scanOf("empty")}
          history={history}
          onImport={jest.fn()}
          onImportHistory={onImportHistory}
        />
      )
      return onImportHistory
    }

    it("stays silent when the disk holds no transcripts", () => {
      renderWith(historyOf({ phase: "empty" }))
      expect(screen.queryByTestId("onboarding-history")).toBeNull()
      expect(screen.queryByTestId("onboarding-history-scanning")).toBeNull()
    })

    it("names every source it found, not only the migratable vendors", () => {
      // Gemini CLI has no `MIGRATION_VENDORS` row, so the config-migration list
      // above can never offer it — this block is what makes it reachable.
      renderWith(
        historyOf({
          phase: "found",
          total: 3,
          sources: [
            { sourceId: "gemini-cli", label: "Gemini CLI", sessions: 2 },
            { sourceId: "claude-code", label: "Claude Code", sessions: 1 },
          ],
        })
      )
      expect(screen.getByTestId("onboarding-history")).toBeInTheDocument()
      expect(screen.getByText("Gemini CLI (2) · Claude Code (1)")).toBeInTheDocument()
    })

    it("brings the conversations across on click", async () => {
      const onImportHistory = renderWith(
        historyOf({ phase: "found", total: 3 }),
        jest.fn().mockResolvedValue(undefined)
      )
      fireEvent.click(screen.getByTestId("onboarding-history-cta"))
      await waitFor(() => expect(onImportHistory).toHaveBeenCalledTimes(1))
    })

    it("reports the count actually written once done", () => {
      renderWith(historyOf({ phase: "done", total: 3, imported: 3, progress: 1 }))
      expect(screen.queryByTestId("onboarding-history-cta")).toBeNull()
      expect(screen.getByText("scan.migrateDone")).toBeInTheDocument()
    })

    it("disables the button while the import runs", () => {
      renderWith(historyOf({ phase: "importing", total: 3, progress: 0.5 }))
      expect(screen.getByTestId("onboarding-history-cta")).toBeDisabled()
    })

    it("says so when part of the scan could not be read", () => {
      renderWith(historyOf({ phase: "found", total: 1, partial: true }))
      expect(screen.getByText("scan.historyPartial")).toBeInTheDocument()
    })
  })
})
