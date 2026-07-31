import { render, screen } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { WorkbenchReconstruction } from "./workbench-reconstruction"

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
})
