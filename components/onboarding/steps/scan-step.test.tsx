/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ScanStep } from "./scan-step"
import { EMPTY_SCAN, type ScanPhase, type ScanResult } from "@/lib/onboarding/scan"
import type { MachineScan } from "@/hooks/onboarding/use-machine-scan"

const scanOf = (phase: ScanPhase, result: Partial<ScanResult> = {}): MachineScan => ({
  phase,
  result: { ...EMPTY_SCAN, ...result },
  rescan: jest.fn(),
})

describe("ScanStep", () => {
  it("shows the scanning state while probing", () => {
    render(<ScanStep shell="tauri" scan={scanOf("scanning")} onImport={jest.fn()} />)
    expect(screen.getByTestId("onboarding-scan-scanning")).toBeInTheDocument()
  })

  it("offers a rescan rather than only a dead end when empty", () => {
    const scan = scanOf("empty")
    render(<ScanStep shell="tauri" scan={scan} onImport={jest.fn()} />)
    fireEvent.click(screen.getByTestId("onboarding-scan-rescan"))
    expect(scan.rescan).toHaveBeenCalled()
  })

  it("lists found runtimes and whether each is already signed in", () => {
    const scan = scanOf("found", {
      runtimes: [{ id: "claude-code", label: "Claude Code", authenticated: true }],
    })
    render(<ScanStep shell="tauri" scan={scan} onImport={jest.fn()} />)
    expect(screen.getByTestId("onboarding-runtime-claude-code")).toHaveTextContent("Claude Code")
    expect(screen.getByText("scan.authenticated")).toBeInTheDocument()
  })

  it("runs the import inline instead of sending the user to Settings", async () => {
    const onImport = jest.fn().mockResolvedValue(undefined)
    const scan = scanOf("found", { migratable: [{ vendor: "claude-code", installed: true }] })
    render(<ScanStep shell="tauri" scan={scan} onImport={onImport} />)
    fireEvent.click(screen.getByTestId("onboarding-migrate-cta-claude-code"))
    await waitFor(() => expect(onImport).toHaveBeenCalledWith("claude-code"))
    await waitFor(() => expect(screen.getByText("scan.migrateDone")).toBeInTheDocument())
  })

  it("surfaces an import failure inline without blocking the flow", async () => {
    const onImport = jest.fn().mockRejectedValue(new Error("nope"))
    const scan = scanOf("found", { migratable: [{ vendor: "codex", installed: true }] })
    render(<ScanStep shell="tauri" scan={scan} onImport={onImport} />)
    fireEvent.click(screen.getByTestId("onboarding-migrate-cta-codex"))
    await waitFor(() => expect(screen.getByText("scan.migrateFailed")).toBeInTheDocument())
  })

  it("replaces the body with pairing on a paired phone", () => {
    const onOpenPairing = jest.fn()
    render(
      <ScanStep
        shell="mobile-paired"
        scan={scanOf("empty")}
        onImport={jest.fn()}
        onOpenPairing={onOpenPairing}
      />
    )
    // There is no local runtime to find — the compute lives on the desktop.
    expect(screen.queryByTestId("onboarding-scan")).toBeNull()
    fireEvent.click(screen.getByTestId("onboarding-open-pairing"))
    expect(onOpenPairing).toHaveBeenCalled()
  })
})
