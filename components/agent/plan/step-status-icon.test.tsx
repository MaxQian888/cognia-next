/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { stepStatusIcon } from "./step-status-icon"
import type { PlanStepStatus } from "@/types/agent/plan"

function iconClass(status: PlanStepStatus): string {
  const { container } = render(<>{stepStatusIcon(status)}</>)
  return container.querySelector("svg")?.getAttribute("class") ?? ""
}

describe("stepStatusIcon", () => {
  it("draws each status with its own tone", () => {
    expect(iconClass("completed")).toContain("text-green-600")
    expect(iconClass("in_progress")).toContain("animate-pulse")
    expect(iconClass("failed")).toContain("text-rose-600")
    expect(iconClass("blocked")).toContain("text-rose-600")
    expect(iconClass("skipped")).toContain("text-muted-foreground")
  })

  it("falls back to the neutral circle for waiting statuses", () => {
    for (const status of ["pending", "ready"] as const) {
      const cls = iconClass(status)
      expect(cls).toContain("text-muted-foreground")
      expect(cls).not.toContain("animate-pulse")
    }
  })
})
