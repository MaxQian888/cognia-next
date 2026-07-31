import { render, screen } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { TaskArtifact } from "./task-artifact"

const artifacts = en.reconstruction.artifacts

describe("TaskArtifact: context", () => {
  it("names the repository and branch it read", () => {
    render(<TaskArtifact kind="context" copy={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.repository)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.branch)).toBeInTheDocument()
  })

  it("lists every file with the note explaining why it was read", () => {
    render(<TaskArtifact kind="context" copy={en.reconstruction} />)
    for (const file of DEMO_TASK.files) {
      expect(screen.getByText(file.path)).toBeInTheDocument()
      expect(screen.getByText(artifacts.context.fileNotes[file.key])).toBeInTheDocument()
    }
  })

  it("shows the project instructions the agent was given", () => {
    render(<TaskArtifact kind="context" copy={en.reconstruction} />)
    for (const line of artifacts.context.instructions) {
      expect(screen.getByText(line)).toBeInTheDocument()
    }
  })
})

describe("TaskArtifact: plan", () => {
  it("renders every plan step in the fixture's order", () => {
    render(<TaskArtifact kind="plan" copy={en.reconstruction} />)
    const items = screen.getAllByRole("listitem").map((node) => node.textContent ?? "")
    expect(items).toHaveLength(DEMO_TASK.plan.length)
    DEMO_TASK.plan.forEach((step, index) => {
      expect(items[index]).toContain(artifacts.plan.items[step.key].text)
    })
  })

  it("states each step's state in words, not only with a glyph", () => {
    render(<TaskArtifact kind="plan" copy={en.reconstruction} />)
    expect(screen.getAllByText(new RegExp(artifacts.plan.stateLabels.done)).length).toBeGreaterThan(
      0
    )
    expect(screen.getByText(new RegExp(artifacts.plan.stateLabels.active))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(artifacts.plan.stateLabels.todo))).toBeInTheDocument()
  })

  it("names the tool each step needs", () => {
    render(<TaskArtifact kind="plan" copy={en.reconstruction} />)
    expect(screen.getAllByText(new RegExp(DEMO_TASK.plan[0].tool)).length).toBeGreaterThan(0)
  })
})

describe("TaskArtifact: diff", () => {
  it("shows the change as a diff rather than describing it", () => {
    render(<TaskArtifact kind="diff" copy={en.reconstruction} />)
    for (const line of DEMO_TASK.diff.lines) {
      expect(screen.getByText(line.text.trim())).toBeInTheDocument()
    }
  })

  it("reports the counts alongside the body", () => {
    render(<TaskArtifact kind="diff" copy={en.reconstruction} />)
    expect(
      screen.getByText(`+${DEMO_TASK.diff.added} ${artifacts.diff.addedLabel}`)
    ).toBeInTheDocument()
    expect(
      screen.getByText(`−${DEMO_TASK.diff.removed} ${artifacts.diff.removedLabel}`)
    ).toBeInTheDocument()
  })

  it("says nothing has left the workspace yet", () => {
    render(<TaskArtifact kind="diff" copy={en.reconstruction} />)
    expect(screen.getByText(artifacts.diff.note)).toBeInTheDocument()
  })
})

describe("TaskArtifact: approval", () => {
  it("names the action and its target", () => {
    render(<TaskArtifact kind="approval" copy={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.approval.command)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.approval.target)).toBeInTheDocument()
  })

  it("spells out what the permission would allow", () => {
    render(<TaskArtifact kind="approval" copy={en.reconstruction} />)
    for (const line of artifacts.approval.scope) {
      expect(screen.getByText(line)).toBeInTheDocument()
    }
  })

  it("depicts the controls without offering a button that does nothing", () => {
    render(<TaskArtifact kind="approval" copy={en.reconstruction} />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText(artifacts.approval.approveLabel)).toBeInTheDocument()
    expect(screen.getByText(artifacts.approval.denyLabel)).toBeInTheDocument()
  })

  it("says plainly that the controls are a depiction", () => {
    render(<TaskArtifact kind="approval" copy={en.reconstruction} />)
    expect(screen.getByText(artifacts.approval.inertNote)).toBeInTheDocument()
  })
})

describe("TaskArtifact: test", () => {
  it("shows the command that produced the output", () => {
    render(<TaskArtifact kind="test" copy={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.test.command)).toBeInTheDocument()
  })

  it("renders every output line with its state in words", () => {
    render(<TaskArtifact kind="test" copy={en.reconstruction} />)
    for (const line of DEMO_TASK.test.lines) {
      expect(screen.getByText(line.name)).toBeInTheDocument()
      expect(
        screen.getAllByText(
          new RegExp(
            `${artifacts.test.stateLabels[line.state]}.*${artifacts.test.lineNotes[line.key]}`
          )
        ).length
      ).toBeGreaterThan(0)
    }
  })

  it("marks the failing assertion distinctly from the passing ones", () => {
    const { container } = render(<TaskArtifact kind="test" copy={en.reconstruction} />)
    const marks = Array.from(container.querySelectorAll("[aria-hidden]")).map((n) => n.textContent)
    expect(marks).toContain("✗")
    expect(marks).toContain("✓")
  })

  it("explains that the re-run has not happened yet", () => {
    render(<TaskArtifact kind="test" copy={en.reconstruction} />)
    expect(screen.getByText(artifacts.test.summary)).toBeInTheDocument()
  })
})

describe("TaskArtifact: artifact", () => {
  it("names the file and the version it belongs to", () => {
    render(<TaskArtifact kind="artifact" copy={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.artifact.file)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.artifact.version)).toBeInTheDocument()
  })

  it("renders each section of the notes with its items", () => {
    render(<TaskArtifact kind="artifact" copy={en.reconstruction} />)
    for (const section of artifacts.artifact.sections) {
      expect(screen.getByRole("heading", { name: section.title })).toBeInTheDocument()
      for (const item of section.items) {
        expect(screen.getByText(item)).toBeInTheDocument()
      }
    }
  })
})

describe("TaskArtifact localisation", () => {
  it("renders the Chinese prose while keeping the untranslated technical strings", () => {
    render(<TaskArtifact kind="context" copy={zh.reconstruction} />)
    expect(
      screen.getByText(zh.reconstruction.artifacts.context.fileNotes.source)
    ).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.files[0].path)).toBeInTheDocument()
  })

  it("keeps the diff body identical across locales, because code does not translate", () => {
    const { unmount } = render(<TaskArtifact kind="diff" copy={en.reconstruction} />)
    const first = DEMO_TASK.diff.lines[0].text.trim()
    expect(screen.getByText(first)).toBeInTheDocument()
    unmount()

    render(<TaskArtifact kind="diff" copy={zh.reconstruction} />)
    expect(screen.getByText(first)).toBeInTheDocument()
  })
})
