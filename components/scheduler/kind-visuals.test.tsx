import { render, renderHook, screen } from "@testing-library/react"

import {
  AuthoredByBadge,
  ItemStatusBadge,
  ItemStatusDot,
  KIND_ICON,
  KIND_PLATE,
  KindIcon,
  KindPlate,
  SEVERITY_TONE,
  useTriggerText,
} from "./kind-visuals"
import { SCHEDULED_ITEM_KINDS } from "@/types/scheduler/unified"

describe("kind visuals", () => {
  it("has an icon and a plate for every kind", () => {
    for (const kind of SCHEDULED_ITEM_KINDS) {
      expect(KIND_ICON[kind]).toBeDefined()
      expect(KIND_PLATE[kind]).toMatch(/bg-/)
    }
    render(<KindPlate kind="workflow" />)
    expect(screen.getByTestId("kind-plate-workflow")).toBeInTheDocument()
    const { container } = render(<KindIcon kind="backup" className="size-5" />)
    expect(container.querySelector("svg")).toHaveClass("size-5")
  })

  it("names the status on the dot and the badge", () => {
    render(
      <>
        <ItemStatusDot status="paused" />
        <ItemStatusBadge status="expired" />
      </>
    )
    expect(screen.getByRole("img", { name: "Paused" })).toBeInTheDocument()
    expect(screen.getByTestId("item-status-badge-expired")).toHaveTextContent("Expired")
  })

  it("shows an authored-by badge only for an agent or a plugin", () => {
    const { rerender } = render(<AuthoredByBadge source="agent" />)
    expect(screen.getByTestId("authored-by-agent")).toHaveTextContent("Agent")
    rerender(<AuthoredByBadge source="user" />)
    expect(screen.queryByTestId("authored-by-agent")).not.toBeInTheDocument()
    rerender(<AuthoredByBadge source={undefined} />)
    expect(screen.queryByTestId(/authored-by/)).not.toBeInTheDocument()
  })

  it("carries a text, dot and border tone per severity", () => {
    for (const severity of ["critical", "attention", "info"] as const) {
      expect(SEVERITY_TONE[severity].text).toMatch(/text-/)
      expect(SEVERITY_TONE[severity].dot).toMatch(/bg-/)
      expect(SEVERITY_TONE[severity].border).toMatch(/border-/)
    }
  })

  it("describes a trigger in one line", () => {
    const { result } = renderHook(() => useTriggerText())
    expect(result.current({ type: "cron", cron: "0 9 * * *" })).toBe("0 9 * * *")
    expect(result.current({ type: "interval", intervalMs: 3_600_000 })).toBe("Every 1h")
    expect(result.current({ type: "event", eventType: "backup:completed" })).toBe(
      "backup:completed"
    )
    expect(result.current({ type: "once" })).toBe("One Time")
    expect(result.current({ type: "once", runAtMs: Date.UTC(2026, 0, 1) })).toMatch(/2026|1\//)
  })
})
