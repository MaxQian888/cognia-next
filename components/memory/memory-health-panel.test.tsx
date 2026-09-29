/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Memory } from "@/types/memory/memory"
import type { MemoryLintReport } from "@/lib/memory/lint/run-memory-lint"
import { MemoryHealthPanel, type MemoryHealthPanelProps } from "./memory-health-panel"

const NOW = 1_700_000_000_000

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    scope: "global",
    type: "episodic",
    text: "Fixed the flaky build",
    tags: [],
    importance: 5,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: NOW,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function report(over: Partial<MemoryLintReport> = {}): MemoryLintReport {
  return { findings: [], contradictionCheck: "ran", scanned: 3, ...over }
}

function setup(over: Partial<MemoryHealthPanelProps> = {}) {
  const props: MemoryHealthPanelProps = {
    report: report(),
    loading: false,
    onRefresh: jest.fn(),
    resolveMemory: () => undefined,
    onOpenMemory: jest.fn(),
    ...over,
  }
  render(<MemoryHealthPanel {...props} />)
  return props
}

describe("MemoryHealthPanel", () => {
  it("shows the empty state and scan meta when a report has no findings", () => {
    setup({ report: report({ scanned: 3, contradictionCheck: "no_vectors" }) })
    expect(screen.getByText("No issues found.")).toBeInTheDocument()
    expect(screen.queryByTestId("memory-health-findings")).toBeNull()
    const meta = screen.getByTestId("memory-health-meta").textContent ?? ""
    expect(meta).toContain("3 memories checked")
    expect(meta).toContain("Contradiction check skipped: no stored vectors are available.")
  })

  it("explains when the contradiction check was disabled", () => {
    setup({ report: report({ contradictionCheck: "disabled" }) })
    const meta = screen.getByTestId("memory-health-meta").textContent ?? ""
    expect(meta).toContain("Contradiction check is off while memory is disabled or temporary.")
  })

  it("renders no meta and no empty state before the first report arrives", () => {
    setup({ report: undefined, loading: true })
    expect(screen.queryByTestId("memory-health-meta")).toBeNull()
    expect(screen.queryByText("No issues found.")).toBeNull()
  })

  it("disables refresh and says it is checking while loading", () => {
    setup({ loading: true })
    const refresh = screen.getByTestId("memory-health-refresh")
    expect(refresh).toBeDisabled()
    expect(refresh).toHaveTextContent("Checking…")
  })

  it("re-runs the check from the refresh button", async () => {
    const user = userEvent.setup()
    const { onRefresh } = setup()
    const refresh = screen.getByTestId("memory-health-refresh")
    expect(refresh).toHaveTextContent("Check again")
    await user.click(refresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("renders each finding's title, severity and metric-filled description", () => {
    setup({
      report: report({
        findings: [
          { kind: "stale", severity: "info", memoryIds: ["m1"], metrics: { ageDays: 45 } },
          {
            kind: "duplicate",
            severity: "warning",
            memoryIds: ["m1", "m2"],
            metrics: { count: 2 },
          },
        ],
      }),
      resolveMemory: (id) => mem({ id, text: `text of ${id}` }),
    })
    const findings = screen.getAllByTestId("memory-health-finding")
    expect(findings.map((f) => f.dataset.kind)).toEqual(["stale", "duplicate"])

    expect(within(findings[0]!).getByText("Never used")).toBeInTheDocument()
    expect(within(findings[0]!).getByText("Note")).toBeInTheDocument()
    expect(
      within(findings[0]!).getByText("An episode from 45 days ago that has never been recalled.")
    ).toBeInTheDocument()

    expect(within(findings[1]!).getByText("Duplicate")).toBeInTheDocument()
    expect(within(findings[1]!).getByText("Warning")).toBeInTheDocument()
    expect(
      within(findings[1]!).getByText("2 memories say the same thing in the same scope.")
    ).toBeInTheDocument()
    expect(within(findings[1]!).getByText("text of m1")).toBeInTheDocument()
    expect(within(findings[1]!).getByText("text of m2")).toBeInTheDocument()
  })

  it("renders a metric-less finding's description", () => {
    setup({
      report: report({
        findings: [{ kind: "missing_evidence", severity: "warning", memoryIds: ["m1"] }],
      }),
      resolveMemory: (id) => mem({ id }),
    })
    expect(
      screen.getByText("Every source that supported this memory has since been deleted.")
    ).toBeInTheDocument()
  })

  it("opens the memory a finding points at", async () => {
    const user = userEvent.setup()
    const { onOpenMemory } = setup({
      report: report({
        findings: [
          { kind: "conflict_open", severity: "warning", memoryIds: ["m7"], metrics: { count: 1 } },
        ],
      }),
      resolveMemory: (id) => mem({ id }),
    })
    await user.click(screen.getByRole("button", { name: "Open" }))
    expect(onOpenMemory).toHaveBeenCalledWith("m7")
  })

  it("marks a memory that no longer resolves as deleted and offers no Open", () => {
    setup({
      report: report({
        findings: [
          {
            kind: "suspected_contradiction",
            severity: "info",
            memoryIds: ["live", "gone"],
            metrics: { similarity: 0.6 },
          },
        ],
      }),
      resolveMemory: (id) => (id === "live" ? mem({ id, text: "still here" }) : undefined),
    })
    expect(screen.getByText("still here")).toBeInTheDocument()
    expect(screen.getByText("(deleted)")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1)
  })
})
