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

  it.each([
    [{ externalAgentSandboxReady: true, externalAgentPlatformSupported: true }, "strict launcher"],
    [
      { externalAgentSandboxReady: false, externalAgentPlatformSupported: true },
      "launcher missing",
    ],
    [
      { externalAgentSandboxReady: false, externalAgentPlatformSupported: false },
      "unsupported on this platform",
    ],
  ])("reports sandbox readiness alongside the command check", (patch, expected) => {
    const { container } = render(
      <DoctorPanel
        report={{ ...report, ...patch }}
        onClose={() => undefined}
        onViewReport={() => undefined}
      />
    )
    const text = container.textContent ?? ""
    // The command check alone would still read "npx ✓" here.
    expect(text).toContain("Sandbox")
    expect(text).toContain(expected)
  })

  it("omits the sandbox row on the built-in backend", () => {
    const { container } = render(
      <DoctorPanel
        report={{ ...report, agentBackend: "builtin", externalAgentSandboxReady: undefined }}
        onClose={() => undefined}
        onViewReport={() => undefined}
      />
    )
    expect(container.textContent ?? "").not.toContain("Sandbox")
  })

  it("renders built-in lazy service status from the session snapshot", () => {
    const { container } = render(
      <DoctorPanel
        report={{
          ...report,
          agentBackend: "builtin",
          cogniaParity: {
            backend: "builtin",
            contextVersion: "v1",
            attachable: true,
            running: true,
            builtinToolCount: 3,
            hostToolCount: 1,
            userMcpCount: 0,
            connections: 1,
            restartRequired: [],
            builtin: {
              phase: "ready",
              runtime: "ai-sdk",
              capabilities: [],
              skills: false,
              categories: { lsp: { state: "initializing", reason: "Initialized on first use" } },
            },
          },
        }}
        onClose={() => {}}
        onViewReport={() => {}}
      />
    )
    expect(container.textContent).toContain("lsp: initializing — Initialized on first use")
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

  it("reports an unresolvable logs directory too", () => {
    const { container } = render(
      <DoctorPanel
        report={{ ...report, logsDir: null }}
        onClose={() => undefined}
        onViewReport={() => undefined}
      />
    )
    expect(container.textContent ?? "").toContain("unable to resolve")
  })

  it("labels a crash report that carries neither a kind nor a capture time", () => {
    const { container } = render(
      <DoctorPanel
        report={{
          ...report,
          latestCrash: {
            stem: "crash-bare",
            sizeBytes: 10,
            hasTxt: true,
            hasJson: false,
            hasDmp: false,
          },
        }}
        onClose={() => undefined}
        onViewReport={() => undefined}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("crash-bare")
    expect(text).toContain("unknown")
  })

  it("clamps arrow navigation to the single available crash report", () => {
    const view = jest.fn()
    render(<DoctorPanel report={report} onClose={() => undefined} onViewReport={view} />)
    __fireInput("", { downArrow: true })
    __fireInput("", { upArrow: true })
    __fireInput("", { return: true })
    expect(view).toHaveBeenCalledWith("crash-2026-05-25_14-30-00-panic")
  })
})
