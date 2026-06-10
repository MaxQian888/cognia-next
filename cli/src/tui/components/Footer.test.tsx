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
})
