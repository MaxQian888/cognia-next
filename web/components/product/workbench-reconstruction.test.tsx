import { render, screen } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { WORKBENCH_COMPLETE, WorkbenchReconstruction } from "./workbench-reconstruction"

jest.mock("motion/react", () => ({
  useInView: () => true,
  motion: {
    p: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <p className={className}>{children}</p>
    ),
  },
}))

const workbench = en.reconstruction.workbench

describe("WorkbenchReconstruction", () => {
  it("carries the reconstruction marker rather than passing as a screenshot", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("names the demo project and its branch", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.repository)).toBeInTheDocument()
    expect(screen.getByText(`${workbench.branchLabel} ${DEMO_TASK.branch}`)).toBeInTheDocument()
  })

  it("shows all five activity-rail regions", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    for (const key of DEMO_TASK.rail) {
      expect(screen.getByText(workbench.rail[key])).toBeInTheDocument()
    }
  })

  it("does not add a second navigation landmark for a rail nobody can navigate", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("renders the thread with both speakers named", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(workbench.youLabel)).toBeInTheDocument()
    expect(screen.getByText(workbench.userTurn)).toBeInTheDocument()
    expect(screen.getByText(workbench.agentLabel)).toBeInTheDocument()
    expect(screen.getByText(workbench.agentTurn)).toBeInTheDocument()
  })

  it("shows a tool call, which is what makes the thread a work record", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(workbench.toolCallLabel)).toBeInTheDocument()
    expect(screen.getByText(workbench.toolCallDetail)).toBeInTheDocument()
  })

  it("stops on the waiting-for-approval state the page argues about", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(workbench.statusLine)).toBeInTheDocument()
  })

  it("puts the diff in the dock rather than an empty tab strip", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(workbench.tabs.diff)).toBeInTheDocument()
    expect(screen.getByText(workbench.tabs.artifact)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.diff.path)).toBeInTheDocument()
  })

  it("truncates the dock diff, which is a corner of the pane and not the whole change", () => {
    render(<WorkbenchReconstruction copy={en.reconstruction} />)
    const last = DEMO_TASK.diff.lines[DEMO_TASK.diff.lines.length - 1]
    expect(screen.queryByText(last.text)).toBeNull()
  })

  it("localises every label", () => {
    render(<WorkbenchReconstruction copy={zh.reconstruction} />)
    expect(screen.getByText(zh.reconstruction.workbench.rail.chat)).toBeInTheDocument()
    expect(screen.getByText(zh.reconstruction.workbench.statusLine)).toBeInTheDocument()
  })

  it("passes a layout class through", () => {
    const { container } = render(
      <WorkbenchReconstruction copy={en.reconstruction} className="my-class" />
    )
    expect(container.querySelector(".my-class")).toBeInTheDocument()
  })

  describe("phased rendering", () => {
    it("defaults to the finished state", () => {
      render(<WorkbenchReconstruction copy={en.reconstruction} />)
      expect(screen.getByText(workbench.statusLine)).toBeInTheDocument()
      expect(screen.getByText(DEMO_TASK.diff.lines[0].text.trim())).toBeInTheDocument()
    })

    it("shows only the request at the opening phase", () => {
      render(<WorkbenchReconstruction copy={en.reconstruction} phase={0} />)
      expect(screen.getByText(workbench.userTurn)).toBeInTheDocument()
      expect(screen.queryByText(workbench.agentTurn)).toBeNull()
      expect(screen.queryByText(workbench.toolCallLabel)).toBeNull()
      expect(screen.queryByText(DEMO_TASK.diff.lines[0].text.trim())).toBeNull()
      expect(screen.queryByText(workbench.statusLine)).toBeNull()
    })

    it("adds the reply, the tool call, the diff and the checkpoint in that order", () => {
      const seen = [1, 2, 3, 4].map((phase) => {
        const { unmount } = render(
          <WorkbenchReconstruction copy={en.reconstruction} phase={phase} />
        )
        const state = {
          reply: screen.queryByText(workbench.agentTurn) !== null,
          tool: screen.queryByText(workbench.toolCallLabel) !== null,
          diff: screen.queryByText(DEMO_TASK.diff.lines[0].text.trim()) !== null,
          approval: screen.queryByText(workbench.statusLine) !== null,
        }
        unmount()
        return state
      })
      expect(seen[0]).toEqual({ reply: true, tool: false, diff: false, approval: false })
      expect(seen[1]).toEqual({ reply: true, tool: true, diff: false, approval: false })
      expect(seen[2]).toEqual({ reply: true, tool: true, diff: true, approval: false })
      expect(seen[3]).toEqual({ reply: true, tool: true, diff: true, approval: true })
      expect(WORKBENCH_COMPLETE).toBe(4)
    })

    it("keeps the dock's file name visible before the diff lands, so the pane never reads as empty chrome", () => {
      render(<WorkbenchReconstruction copy={en.reconstruction} phase={1} />)
      expect(screen.getByText(DEMO_TASK.diff.path)).toBeInTheDocument()
    })

    it("stays free of arrival animation unless it is live", () => {
      const { container } = render(
        <WorkbenchReconstruction copy={en.reconstruction} phase={WORKBENCH_COMPLETE} />
      )
      expect(container.querySelector('[class*="fade-through"]')).toBeNull()
    })

    it("lets each turn arrive when live", () => {
      const { container } = render(
        <WorkbenchReconstruction copy={en.reconstruction} phase={WORKBENCH_COMPLETE} live />
      )
      expect(container.querySelector('[data-phase="reply"]')?.className).toMatch(/fade-through/)
      expect(container.querySelectorAll("[data-reveal-line]").length).toBeGreaterThan(0)
    })
  })
})
