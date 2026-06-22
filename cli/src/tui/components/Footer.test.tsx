import fs from "node:fs"
import React from "react"
import { render } from "@testing-library/react"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { Footer } from "./Footer"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  model: "claude-x",
  providers: { anthropic: { model: "claude-x" } },
  cwd: "/work",
}

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
    // Discoverability hint is shown while idle.
    expect(text).toContain("⚙ /settings")
  })

  it("shows a rotating working verb and the interrupt hint while streaming", () => {
    const { container } = render(<Footer config={config} turnStatus="streaming" />)
    const text = container.textContent ?? ""
    // The first frame reads "Working"; the verb rotates on a timer thereafter.
    expect(text).toContain("Working")
    expect(text).toContain("esc to interrupt")
    // The settings hint yields to the spinner while busy.
    expect(text).not.toContain("⚙ /settings")
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

  it("does not reread git branch when rerendered with stable props", () => {
    const readFile = jest.spyOn(fs, "readFileSync").mockReturnValue("ref: refs/heads/main")
    const cfg: ResolvedConfig = { ...config, statusBar: { segments: ["git"] } }
    const { rerender } = render(<Footer config={cfg} turnStatus="idle" />)
    expect(readFile).toHaveBeenCalledTimes(1)
    rerender(<Footer config={cfg} turnStatus="idle" />)
    expect(readFile).toHaveBeenCalledTimes(1)
    readFile.mockRestore()
  })

  it("shows a 📋 chip with the plan title when a plan is on file", () => {
    const { container } = render(
      <Footer config={config} turnStatus="idle" planTitle="Refactor the parser" />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("📋")
    expect(text).toContain("Refactor the parser")
  })

  it("shows a ⚙ copilot chip with the draft name + exit hint when in copilot mode", () => {
    const { container } = render(
      <Footer config={config} turnStatus="idle" copilot={{ name: "Nightly report" }} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("copilot: Nightly report")
    expect(text).toContain("/workflow exit")
  })

  it("omits the plan chip when no plan is set", () => {
    const { container } = render(<Footer config={config} turnStatus="idle" />)
    expect(container.textContent ?? "").not.toContain("📋")
  })

  it("shows a btw chip with the queued steer count", () => {
    const { container } = render(<Footer config={config} turnStatus="idle" steerCount={2} />)
    expect(container.textContent ?? "").toContain("btw×2")
  })

  it("omits the btw chip when nothing is queued", () => {
    const { container } = render(<Footer config={config} turnStatus="idle" steerCount={0} />)
    expect(container.textContent ?? "").not.toContain("btw")
  })

  it("shows a ◆ sub-agent chip while a dispatch is running", () => {
    const { container } = render(
      <Footer
        config={config}
        turnStatus="streaming"
        subagentRunning={{ name: "reviewer", count: 1 }}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("◆")
    expect(text).toContain("reviewer")
  })

  it("shows the running count when more than one sub-agent is in flight", () => {
    const { container } = render(
      <Footer
        config={config}
        turnStatus="streaming"
        subagentRunning={{ name: "planner", count: 3 }}
      />
    )
    expect(container.textContent ?? "").toContain("×3")
  })

  it("omits the sub-agent chip when none is running", () => {
    const { container } = render(<Footer config={config} turnStatus="idle" />)
    expect(container.textContent ?? "").not.toContain("◆")
  })

  it("shows a ⧗ background chip with the count of detached subagent runs", () => {
    const { container } = render(
      <Footer config={config} turnStatus="idle" backgroundSubagents={2} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("⧗")
    expect(text).toContain("2 bg")
  })

  it("omits the background chip when no detached runs are in flight", () => {
    const { container } = render(
      <Footer config={config} turnStatus="idle" backgroundSubagents={0} />
    )
    expect(container.textContent ?? "").not.toContain("⧗")
  })

  it("shows interrupted detached background runs separately", () => {
    const { container } = render(
      <Footer config={config} turnStatus="idle" interruptedBackgroundSubagents={2} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("! 2 bg interrupted")
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
