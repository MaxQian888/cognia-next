import React from "react"
import { render } from "@testing-library/react"
import { __resetInk } from "ink"

import { BackendInstall, tailLines } from "./BackendInstall"
import type { BackendInstallState } from "../state/types"

describe("tailLines", () => {
  it("keeps only the last `max` lines", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toEqual(["c", "d"])
  })

  it("drops a trailing blank line from a newline-terminated log", () => {
    expect(tailLines("a\nb\n", 5)).toEqual(["a", "b"])
  })

  it("returns nothing when the budget is zero", () => {
    expect(tailLines("a\nb", 0)).toEqual([])
  })

  it("returns every line when fewer than the budget", () => {
    expect(tailLines("only", 10)).toEqual(["only"])
  })
})

describe("BackendInstall", () => {
  beforeEach(() => __resetInk())

  const install: BackendInstallState = {
    name: "OpenAI Codex CLI",
    display: "npm install -g @openai/codex",
    output: "added 1 package\nnpm warn deprecated foo\n",
    status: "running",
  }

  it("shows the agent, the exact command, and the streamed output", () => {
    const { container } = render(<BackendInstall install={install} maxRows={12} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Installing OpenAI Codex CLI")
    expect(text).toContain("npm install -g @openai/codex")
    expect(text).toContain("added 1 package")
    expect(text).toContain("npm warn deprecated foo")
  })

  it("windows the output to the row budget", () => {
    const many = {
      ...install,
      output: Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n"),
    }
    const { container } = render(<BackendInstall install={many} maxRows={5} />)
    const text = container.textContent ?? ""
    // Budget is maxRows - 2 header rows = 3 lines; the newest survive.
    expect(text).toContain("line-39")
    expect(text).not.toContain("line-0")
  })

  it("falls back to a default budget when maxRows is omitted", () => {
    const { container } = render(<BackendInstall install={install} />)
    // Still renders the header + command with no maxRows prop.
    expect(container.textContent ?? "").toContain("Installing OpenAI Codex CLI")
  })
})
