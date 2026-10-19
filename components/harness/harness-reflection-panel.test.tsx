/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { HarnessReflectionPanel } from "./harness-reflection-panel"

describe("HarnessReflectionPanel", () => {
  it("shows each edit's verdict and links the stored lesson", () => {
    const onOpen = jest.fn()
    render(
      <HarnessReflectionPanel
        reflection={{
          edits: [
            {
              component: "memory.md",
              candidates: ["dom1", "agg1"],
              change: "note on separators",
              observed: "dom1 parsed the file",
              verdict: "helped",
            },
            {
              component: "tool_rules.json",
              candidates: ["inv1"],
              change: "cap Bash",
              observed: "no difference",
              verdict: "no observed effect",
            },
          ],
          retrieved: [{ id: "exp-0", verdict: "hurt" }],
          experienceId: "exp-9",
          conflictsWith: ["exp-3", "exp-4"],
        }}
        onOpenExperience={onOpen}
      />
    )
    expect(screen.getByText("Helped")).toBeInTheDocument()
    expect(screen.getByText("No observed effect")).toBeInTheDocument()
    expect(screen.getByText("Task-specific edit 1, Combined harness 1")).toBeInTheDocument()
    expect(screen.getByText("The lesson was added to the library.")).toBeInTheDocument()
    expect(screen.getByText("It contradicts 2 existing lessons.")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Open lesson"))
    expect(onOpen).toHaveBeenCalledWith("exp-9")
    fireEvent.click(screen.getByText("Hurt"))
    expect(onOpen).toHaveBeenCalledWith("exp-0")
  })

  it("says why no lesson was kept, or where it was merged", () => {
    const { rerender } = render(
      <HarnessReflectionPanel
        reflection={{ edits: [], retrieved: [], droppedExperience: "no effect" }}
      />
    )
    expect(screen.getByText("The reflection attributed no edits.")).toBeInTheDocument()
    expect(screen.getByText("No lesson was kept: no effect")).toBeInTheDocument()
    rerender(
      <HarnessReflectionPanel reflection={{ edits: [], retrieved: [], mergedInto: "exp-1" }} />
    )
    expect(screen.getByText(/merged into an existing one/)).toBeInTheDocument()
  })
})
