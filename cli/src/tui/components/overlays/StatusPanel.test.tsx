import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { StatusPanel } from "./StatusPanel"
import type { StatusReport } from "../../state/types"

const report: StatusReport = {
  version: "9.9.9",
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

  it("shows a dash when no git branch", () => {
    const { container } = render(
      <StatusPanel report={{ ...report, gitBranch: null }} onClose={() => {}} />
    )
    expect(container.textContent).toContain("—")
  })

  it("closes on Escape", () => {
    const onClose = jest.fn()
    render(<StatusPanel report={report} onClose={onClose} />)
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })
})
