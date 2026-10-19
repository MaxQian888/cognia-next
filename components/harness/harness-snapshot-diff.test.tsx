/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { makeComponents, makeSkill } from "@/lib/harness/test-fixtures"
import type { DiffLine } from "@/lib/artifacts/diff"
import { HarnessSnapshotDiff } from "./harness-snapshot-diff"

// The real view virtualizes its rows, which jsdom cannot lay out; the probe
// shows the lines it was handed.
jest.mock("@/components/diff/line-diff-view", () => ({
  LineDiffView: ({
    lines,
    "data-testid": testId,
  }: {
    lines: DiffLine[]
    "data-testid": string
  }) => (
    <pre data-testid={testId}>
      {lines
        .map((l) => `${l.type === "added" ? "+" : l.type === "removed" ? "-" : " "}${l.content}`)
        .join("\n")}
    </pre>
  ),
}))

describe("HarnessSnapshotDiff", () => {
  it("lists every changed file of the editable tree with its kind of change", () => {
    const before = makeComponents()
    const after = makeComponents({
      memory: `${before.memory}\nCSV files may use ; separators.`,
      skills: [
        ...before.skills,
        makeSkill({ key: "csv-check", name: "csv-check", content: "Check the header." }),
      ],
    })
    render(<HarnessSnapshotDiff before={before} after={after} />)
    expect(screen.getByTestId("harness-diff")).toBeInTheDocument()
    expect(screen.getByText("memory.md")).toBeInTheDocument()
    expect(screen.getByText("skills/csv-check/SKILL.md")).toBeInTheDocument()
    expect(screen.getAllByText("Added").length).toBeGreaterThan(0)
    expect(screen.getByText("Changed")).toBeInTheDocument()
    expect(screen.getByTestId("harness-diff-memory.md")).toHaveTextContent(
      "+CSV files may use ; separators."
    )
  })

  it("says so when nothing differs", () => {
    const same = makeComponents()
    render(<HarnessSnapshotDiff before={same} after={same} />)
    expect(screen.getByTestId("harness-diff-empty")).toHaveTextContent("identical")
  })
})
