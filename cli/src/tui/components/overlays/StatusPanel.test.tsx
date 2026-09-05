import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { StatusPanel } from "./StatusPanel"
import type { StatusReport } from "../../state/types"

const report: StatusReport = {
  version: "9.9.9",
  agentBackend: "builtin",
  provider: "anthropic",
  model: "claude-x",
  modelValid: true,
  auth: "api key",
  credentialedProviders: ["anthropic", "openai"],
  cwd: "/work",
  gitBranch: "main",
  contextPct: 42,
  contextTokens: 1100,
  contextWindow: 200000,
  dbSnapshotExists: true,
}

describe("StatusPanel", () => {
  beforeEach(() => __resetInk())

  it("renders the health + context facts", () => {
    const { container } = render(<StatusPanel report={report} onClose={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).toContain("cognia-agent v9.9.9")
    expect(text).toContain("anthropic")
    expect(text).toContain("claude-x")
    expect(text).toContain("api key")
    expect(text).toContain("main")
    expect(text).toContain("42%")
    expect(text).toContain("/work")
  })

  it("keeps the token count but drops the gauge when the window is unknown", () => {
    // An external agent whose real window nothing resolved — a "/ 200k" or a
    // percentage here would come from the built-in provider's table.
    const { container } = render(
      <StatusPanel
        report={{ ...report, contextPct: undefined, contextWindow: undefined }}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("1.1k used · window unknown for this agent")
    expect(text).not.toContain("42%")
  })

  it("shows a dash when no git branch", () => {
    const { container } = render(
      <StatusPanel report={{ ...report, gitBranch: null }} onClose={() => {}} />
    )
    expect(container.textContent).toContain("—")
  })

  it("shows the live built-in dependency failure and recovery instruction", () => {
    const { container } = render(
      <StatusPanel
        report={{
          ...report,
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
              categories: { sandbox: { state: "failed", reason: "Reinstall the launcher" } },
            },
          },
        }}
        onClose={() => {}}
      />
    )
    expect(container.textContent).toContain("Runtime: ai-sdk · ready")
    expect(container.textContent).toContain("sandbox: failed — Reinstall the launcher")
  })

  it("counts the Cognia tools an external agent can actually call", () => {
    const { container } = render(
      <StatusPanel
        report={{
          ...report,
          cogniaParity: {
            backend: "codex",
            contextVersion: "v124",
            attachable: true,
            running: true,
            builtinToolCount: 12,
            hostToolCount: 3,
            userMcpCount: 1,
            connections: 1,
            restartRequired: [],
          },
        }}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("12 built-in · 3 host · 1 user MCP")
    expect(text).toContain("v124")
  })

  it("distinguishes a bridge that never started from one the agent cannot host", () => {
    const parity = {
      backend: "codex",
      contextVersion: "v124",
      attachable: true,
      running: false,
      builtinToolCount: 0,
      hostToolCount: 0,
      userMcpCount: 0,
      connections: 0,
      restartRequired: [],
    }
    const notStarted = render(
      <StatusPanel report={{ ...report, cogniaParity: parity }} onClose={() => {}} />
    )
    expect(notStarted.container.textContent).toContain("bridge not started")

    __resetInk()
    const unavailable = render(
      <StatusPanel
        report={{ ...report, cogniaParity: { ...parity, attachable: false } }}
        onClose={() => {}}
      />
    )
    expect(unavailable.container.textContent).toContain("unavailable on this agent")
  })

  it("flags a model outside the catalog and a missing local store", () => {
    const { container } = render(
      <StatusPanel
        report={{ ...report, modelValid: false, dbSnapshotExists: false }}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("claude-x ✗")
    expect(text).toContain("✗")
  })

  it("closes on Escape", () => {
    const onClose = jest.fn()
    render(<StatusPanel report={report} onClose={onClose} />)
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })
})
