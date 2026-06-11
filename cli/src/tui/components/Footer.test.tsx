import React from "react"
import { render } from "@testing-library/react"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { Footer } from "./Footer"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, model: "claude-x", cwd: "/work" }

describe("Footer", () => {
  it("shows model, provider, mode and usage when idle", () => {
    const { container } = render(
      <Footer
        config={config}
        usage={{ inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.02 }}
        turnStatus="idle"
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("claude-x")
    expect(text).toContain("anthropic")
    expect(text).toContain("1.5k")
  })

  it("shows the working hint and spinner while streaming", () => {
    const { container } = render(<Footer config={config} turnStatus="streaming" />)
    expect(container.textContent).toContain("working")
  })

  it("shows the stopping hint while aborting", () => {
    const { container } = render(<Footer config={config} turnStatus="aborting" />)
    expect(container.textContent).toContain("stopping")
  })

  it("honors a custom segment list + order and drops the rest", () => {
    const cfg: ResolvedConfig = { ...config, statusBar: { segments: ["mode", "model"] } }
    const { container } = render(<Footer config={cfg} turnStatus="idle" />)
    const text = container.textContent ?? ""
    expect(text).toContain("claude-x")
    expect(text).toContain("default") // permission mode
    // cost/cwd segments are not in the custom list
    expect(text).not.toContain("/work")
  })

  it("renders the git segment from the injected branch", () => {
    const cfg: ResolvedConfig = { ...config, statusBar: { segments: ["git"] } }
    const { container } = render(<Footer config={cfg} turnStatus="idle" gitBranch="feat/x" />)
    expect(container.textContent).toContain("feat/x")
  })

  it("shows a determinate progress pill when activity has a max", () => {
    const { container } = render(
      <Footer
        config={config}
        turnStatus="idle"
        activity={{ kind: "goal", label: "ship it", turns: 2, max: 5, status: "running" }}
      />
    )
    expect(container.textContent).toContain("2/5")
  })
})
