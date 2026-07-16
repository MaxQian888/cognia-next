import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { DoctorPanel } from "./DoctorPanel"
import type { DoctorReport } from "../../state/types"

const report: DoctorReport = {
  version: "1.2.3",
  provider: "anthropic",
  model: "claude-opus-4-8",
  modelValid: true,
  auth: "subscription",
  credentialedProviders: ["anthropic"],
  cwd: "/work",
  dbSnapshotExists: true,
  dbSnapshotPath: "/home/.cognia/db.json",
  agentBackend: "claude-code",
  externalAgentHooksActive: false,
  externalAgentTerminalActive: false,
  externalAgentCommand: "npx",
  externalAgentAvailable: true,
  crashReportsDir: "/data/Cognia/crash-reports",
  logsDir: "/data/Cognia/logs",
  crashReportCount: 1,
  latestCrash: {
    stem: "crash-2026-05-25_14-30-00-panic",
    capturedAt: "2026-05-25T14:30:00Z",
    kind: "panic",
    sizeBytes: 1024,
    hasTxt: true,
    hasJson: true,
    hasDmp: false,
  },
  logDirBytes: 2048,
}

describe("DoctorPanel", () => {
  beforeEach(() => __resetInk())

  it("renders all diagnostic sections", () => {
    const { container } = render(
      <DoctorPanel
        report={report}
        onClose={() => undefined}
        onViewReport={() => undefined}
        onOpenDir={() => undefined}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Doctor · cognia-agent v1.2.3")
    expect(text).toContain("Config")
    expect(text).toContain("Workspace")
    expect(text).toContain("Crash")
    expect(text).toContain("Logs")
    expect(text).toContain("anthropic")
    expect(text).toContain("claude-opus-4-8")
    expect(text).toContain("claude-code")
    expect(text).toContain("npx ✓")
    expect(text).toContain("Hooks inert")
    expect(text).toContain("ACP terminal unavailable")
    expect(text).toContain("/data/Cognia/crash-reports")
    expect(text).toContain("crash-2026-05-25_14-30-00-panic")
  })

  it("flags an invalid model", () => {
    const { container } = render(
      <DoctorPanel
        report={{ ...report, modelValid: false }}
        onClose={() => undefined}
        onViewReport={() => undefined}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("not in catalog")
  })

  it("calls onViewReport when Enter is pressed on a crash report", () => {
    const view = jest.fn()
    render(
      <DoctorPanel
        report={report}
        onClose={() => undefined}
        onViewReport={view}
        onOpenDir={() => undefined}
      />
    )
    __fireInput("", { return: true })
    expect(view).toHaveBeenCalledWith("crash-2026-05-25_14-30-00-panic")
  })

  it("calls onOpenDir when 'o' is pressed", () => {
    const openDir = jest.fn()
    render(
      <DoctorPanel
        report={report}
        onClose={() => undefined}
        onViewReport={() => undefined}
        onOpenDir={openDir}
      />
    )
    __fireInput("o")
    expect(openDir).toHaveBeenCalled()
  })

  it("calls onClose when Esc is pressed", () => {
    const close = jest.fn()
    render(<DoctorPanel report={report} onClose={close} onViewReport={() => undefined} />)
    __fireInput("", { escape: true })
    expect(close).toHaveBeenCalled()
  })

  it("shows a fallback when crash reports dir cannot be resolved", () => {
    const { container } = render(
      <DoctorPanel
        report={{ ...report, crashReportsDir: null, latestCrash: undefined, crashReportCount: 0 }}
        onClose={() => undefined}
        onViewReport={() => undefined}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("unable to resolve")
    expect(text).not.toContain("Recent crash reports")
  })
})
