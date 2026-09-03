import fs from "node:fs"
import React from "react"
import { render } from "@testing-library/react"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { Footer, fitFooterSuffixes, planReserve } from "./Footer"
import type { StatusSegmentView } from "../format/status-bar"

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
        columns={200}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("claude-x")
    expect(text).toContain("anthropic")
    expect(text).toContain("1.5k")
    // Discoverability hint is shown while idle.
    expect(text).toContain("⚙ /settings")
  })

  it("shows current-window context while keeping cumulative billed tokens separate", () => {
    const cfg: ResolvedConfig = {
      ...config,
      statusBar: { segments: ["tokens", "ctx", "cache"] },
    }
    const { container } = render(
      <Footer
        config={cfg}
        usage={{
          inputTokens: 423_000,
          outputTokens: 5_000,
          contextInputTokens: 96_000,
          cacheReadInputTokens: 90_000,
        }}
        contextWindow={1_000_000}
        turnStatus="idle"
        columns={200}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("428k tok")
    expect(text).toContain("19% ctx")
    expect(text).toContain("⚡ 48% · 90k reused")
    expect(text).not.toContain("51% ctx")
    expect(text).not.toContain("⚡ 17%")
  })

  it("hides the discoverability hint while busy (it lives in BottomStatus now)", () => {
    const { container } = render(<Footer config={config} turnStatus="streaming" columns={200} />)
    const text = container.textContent ?? ""
    // The persistent identity line stays; the idle hint yields.
    expect(text).toContain("claude-x")
    expect(text).not.toContain("⚙ /settings")
    // Transient working indicator no longer lives in the Footer.
    expect(text).not.toContain("esc to interrupt")
    expect(text).not.toContain("Working")
  })

  it("populates segmentsRef with the rendered segments for click hit-testing", () => {
    const cfg: ResolvedConfig = { ...config, statusBar: { segments: ["model", "mode"] } }
    const segmentsRef: React.MutableRefObject<StatusSegmentView[] | null> = { current: null }
    render(<Footer config={cfg} turnStatus="idle" columns={200} segmentsRef={segmentsRef} />)
    expect(segmentsRef.current?.map((s) => s.id)).toEqual(["model", "mode"])
  })

  it("honors a custom segment list + order and drops the rest", () => {
    const cfg: ResolvedConfig = { ...config, statusBar: { segments: ["mode", "model"] } }
    const { container } = render(<Footer config={cfg} turnStatus="idle" columns={200} />)
    const text = container.textContent ?? ""
    expect(text).toContain("claude-x")
    expect(text).toContain("default") // permission mode
    // cost/cwd segments are not in the custom list
    expect(text).not.toContain("/work")
  })

  it("renders the git segment from the injected branch", () => {
    const cfg: ResolvedConfig = { ...config, statusBar: { segments: ["git"] } }
    const { container } = render(
      <Footer config={cfg} turnStatus="idle" gitBranch="feat/x" columns={200} />
    )
    expect(container.textContent).toContain("feat/x")
  })

  it("does not reread git branch when rerendered with stable props", () => {
    const readFile = jest.spyOn(fs, "readFileSync").mockReturnValue("ref: refs/heads/main")
    const cfg: ResolvedConfig = { ...config, statusBar: { segments: ["git"] } }
    const { rerender } = render(<Footer config={cfg} turnStatus="idle" columns={200} />)
    expect(readFile).toHaveBeenCalledTimes(1)
    rerender(<Footer config={cfg} turnStatus="idle" columns={200} />)
    expect(readFile).toHaveBeenCalledTimes(1)
    readFile.mockRestore()
  })

  it("shows a 📋 chip with the plan title when a plan is on file", () => {
    const { container } = render(
      <Footer config={config} turnStatus="idle" planTitle="Refactor the parser" columns={200} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("📋")
    expect(text).toContain("Refactor the parser")
  })

  it("omits the plan chip when no plan is set", () => {
    const { container } = render(<Footer config={config} turnStatus="idle" columns={200} />)
    expect(container.textContent ?? "").not.toContain("📋")
  })

  it("drops low-priority segments with a … marker on a narrow terminal", () => {
    const cfg: ResolvedConfig = {
      ...config,
      statusBar: { segments: ["model", "mode", "ctx", "tokens", "git", "cost"] },
    }
    const { container } = render(
      <Footer
        config={cfg}
        usage={{ inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.02 }}
        turnStatus="idle"
        gitBranch="feature/some-long-branch-name"
        columns={28}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("claude-x") // highest priority survives
    expect(text).toContain("…") // truncation marker
  })

  it("budgets plan and hint suffixes into the room the segments left", () => {
    const suffixes = fitFooterSuffixes(26, "A very long plan title that cannot wrap", true)
    expect(suffixes.reservedWidth).toBeLessThanOrEqual(26)
    expect(suffixes.planText).toContain("…")
    // The hint is pure leftover, so a row with no spare columns simply drops it.
    expect(suffixes.hintText).toBe("")
  })

  it("caps what a plan title may reserve before the segments are fitted", () => {
    // A title far longer than the row still gives back two thirds of it.
    expect(planReserve(90, "x".repeat(200))).toBe(30)
    // A short title reserves only what it needs, and no title reserves nothing.
    expect(planReserve(90, "Ship it")).toBe(13)
    expect(planReserve(90, undefined)).toBe(0)
  })

  it("keeps identity segments ahead of the idle hint on a normal terminal", () => {
    const { container } = render(
      <Footer
        config={config}
        usage={{ inputTokens: 91_000, outputTokens: 12_400 }}
        turnStatus="idle"
        gitBranch="dev"
        contextWindow={200_000}
        planTitle="Rebuild the tool cards"
        columns={92}
      />
    )
    const text = container.textContent ?? ""
    // The hint used to be reserved first and cost four identity segments.
    expect(text).toContain("claude-x")
    expect(text).toContain("anthropic")
    expect(text).toContain("tok")
    expect(text).toContain("📋 Rebuild the tool cards")
  })

  it("honors the persisted idle-hint preference", () => {
    const cfg: ResolvedConfig = { ...config, statusBar: { showHints: false } }
    const { container } = render(<Footer config={cfg} turnStatus="idle" columns={200} />)
    expect(container.textContent).not.toContain("⚙ /settings")
  })
})
