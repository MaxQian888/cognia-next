/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { IslandHeader, type IslandHeaderProps } from "./island-header"
import { NO_ISLAND_CAPABILITIES, type IslandRowProjection } from "@/lib/island/types"

const task: IslandRowProjection = {
  id: "chat:c1",
  source: "chat",
  owner: { kind: "chat", sessionId: "c1" },
  status: "working",
  priority: 2,
  title: "Refactor auth",
  summary: "Edit",
  startedAt: 0,
  updatedAt: 0,
  capabilities: { ...NO_ISLAND_CAPABILITIES },
  stale: false,
}

function renderHeader(over: Partial<IslandHeaderProps> = {}) {
  return render(
    <IslandHeader
      layout="flat"
      presentation="compact"
      focus={task}
      announcing={false}
      total={1}
      waiting={0}
      active={1}
      notchWidth={0}
      {...over}
    />
  )
}

describe("flat layout", () => {
  it("names the task on one line: source, title, state and the rest", () => {
    renderHeader({ total: 3 })
    expect(screen.getByTestId("island-header")).toHaveAttribute("data-layout", "flat")
    expect(screen.getByTestId("island-compact-source").textContent).toBe("source.chat")
    expect(screen.getByTestId("island-compact-title").textContent).toBe("Refactor auth")
    expect(screen.getByTestId("island-compact-summary").textContent).toBe("Edit")
    expect(screen.getByTestId("island-compact-more").textContent).toBe('more:{"count":2}')
  })

  it("falls back to the state key when a task has no safe summary", () => {
    renderHeader({
      focus: { ...task, summary: "", status: "blocked", statusKey: "awaitingPermission" },
    })
    expect(screen.getByTestId("island-compact-summary").textContent).toBe(
      "state.awaitingPermission"
    )
  })

  it("counts instead of naming when there is nothing to name or it is minimal", () => {
    const { unmount } = renderHeader({ focus: undefined, total: 0, active: 0 })
    expect(screen.getByTestId("island-summary").textContent).toBe("empty")
    unmount()
    renderHeader({ presentation: "minimal", total: 2, waiting: 1 })
    expect(screen.queryByTestId("island-compact-title")).toBeNull()
    expect(screen.getByTestId("island-summary").textContent).toBe(
      'summaryWaiting:{"count":2,"waiting":1}'
    )
  })

  it("pulses amber while someone is waiting", () => {
    renderHeader({ waiting: 1 })
    expect(screen.getByTestId("island-status-dot").className).toContain("bg-amber-400")
  })
})

describe("notch layout", () => {
  it("splits the facts across the ears and draws nothing over the housing", () => {
    renderHeader({ layout: "notch", notchWidth: 200, total: 2 })
    const header = screen.getByTestId("island-header")
    expect(header).toHaveAttribute("data-layout", "notch")
    expect(header).toHaveStyle({ gridTemplateColumns: "minmax(0, 1fr) 200px minmax(0, 1fr)" })
    // Three columns: leading ear, the empty housing, trailing ear.
    expect(header.children).toHaveLength(3)
    expect(header.children[1].textContent).toBe("")
    expect(screen.getByTestId("island-ear-leading").textContent).toBe("Refactor auth")
    expect(screen.getByTestId("island-ear-trailing").textContent).toContain("Edit")
    expect(screen.getByTestId("island-ear-trailing").textContent).toContain("more")
  })

  it("keeps only the dot and one number when minimal", () => {
    renderHeader({ layout: "notch", notchWidth: 200, presentation: "minimal", waiting: 2 })
    expect(screen.queryByTestId("island-compact-title")).toBeNull()
    expect(screen.getByTestId("island-minimal").textContent).toBe("2")
    expect(screen.getByTestId("island-minimal").className).toContain("text-amber-300")
    expect(screen.getByTestId("island-status-dot")).toBeInTheDocument()
  })

  it("draws nothing at all when minimal and idle", () => {
    renderHeader({
      layout: "notch",
      notchWidth: 200,
      presentation: "minimal",
      focus: undefined,
      total: 0,
      active: 0,
    })
    expect(screen.queryByTestId("island-status-dot")).toBeNull()
    expect(screen.queryByTestId("island-minimal")).toBeNull()
  })

  it("says there is nothing running when compact with no task", () => {
    renderHeader({ layout: "notch", notchWidth: 200, focus: undefined, total: 0, active: 0 })
    expect(screen.getByTestId("island-ear-trailing").textContent).toBe("empty")
  })
})

describe("completion", () => {
  it.each(["flat", "notch"] as const)("announces a finished task in the %s layout", (layout) => {
    renderHeader({
      layout,
      notchWidth: 200,
      announcing: true,
      focus: { ...task, status: "done", summary: "" },
    })
    expect(screen.getByTestId("island-announce-done")).toBeInTheDocument()
    expect(screen.queryByTestId("island-status-dot")).toBeNull()
    expect(screen.getByTestId("island-compact-summary").textContent).toBe("state.done")
  })
})
