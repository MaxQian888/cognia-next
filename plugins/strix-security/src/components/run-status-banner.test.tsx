/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { RunStatusBanner } from "./run-status-banner"
import type { StrixRun } from "../types"
import { en, registerStrixBundle, unregisterStrixBundle } from "../i18n.test-helpers"

beforeEach(() => registerStrixBundle())
afterEach(() => unregisterStrixBundle())

const run = (over: Partial<StrixRun> = {}): StrixRun => ({
  runId: "r1",
  target: "https://x",
  startedAt: 1,
  status: "done",
  findingsCount: 0,
  authorizedAt: 1,
  ...over,
})

describe("RunStatusBanner", () => {
  it("renders nothing for a completed run", () => {
    const { container } = render(<RunStatusBanner run={run()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a live indicator while the scan is running", () => {
    render(<RunStatusBanner run={run({ status: "running" })} />)
    expect(screen.getByTestId("strix-run-running")).toHaveTextContent("https://x")
    // The spinner stops for people who asked the OS for reduced motion.
    const spinner = screen.getByTestId("strix-run-running").querySelector("svg")
    expect(spinner?.getAttribute("class")).toContain("motion-reduce:animate-none")
  })

  it("translates an interrupted run from its code", () => {
    render(
      <RunStatusBanner
        run={run({ status: "cancelled", error: "English", errorCode: "interrupted" })}
      />
    )
    expect(screen.getByTestId("strix-run-cancelled")).toHaveTextContent(en("run.error.interrupted"))
  })

  it("surfaces the failure reason for an errored run", () => {
    render(<RunStatusBanner run={run({ status: "error", error: "docker died" })} />)
    expect(screen.getByTestId("strix-run-error")).toHaveTextContent("docker died")
  })

  it("marks a cancelled run, including an interruption note", () => {
    render(<RunStatusBanner run={run({ status: "cancelled", error: "Scan was interrupted" })} />)
    expect(screen.getByTestId("strix-run-cancelled")).toHaveTextContent("interrupted")
  })
})
