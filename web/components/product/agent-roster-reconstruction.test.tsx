import { render, screen, within } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { AgentRosterReconstruction, ROSTER } from "./agent-roster-reconstruction"

describe("AgentRosterReconstruction", () => {
  it("carries the reconstruction marker", () => {
    render(<AgentRosterReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("shows the team on the signature task's repository and branch", () => {
    render(<AgentRosterReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.repository)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(DEMO_TASK.branch))).toBeInTheDocument()
  })

  it("lists every member with its role, state and the tools its step needs", () => {
    const { container } = render(<AgentRosterReconstruction copy={en.reconstruction} />)
    const rows = container.querySelectorAll("[data-member-state]")
    expect(rows).toHaveLength(en.reconstruction.agents.members.length)
    en.reconstruction.agents.members.forEach((member, index) => {
      const row = rows[index] as HTMLElement
      expect(within(row).getByText(member.role)).toBeInTheDocument()
      expect(within(row).getByText(member.state)).toBeInTheDocument()
      for (const tool of ROSTER[index].tools) {
        expect(within(row).getByText(tool)).toBeInTheDocument()
      }
    })
  })

  it("takes its tools from the plan the rest of the site follows", () => {
    expect(ROSTER.flatMap((member) => member.tools)).toEqual([
      DEMO_TASK.approval.command,
      ...DEMO_TASK.plan.slice(1).map((step) => step.tool),
    ])
  })

  it("keeps amber for the one row waiting on a person", () => {
    const { container } = render(<AgentRosterReconstruction copy={en.reconstruction} />)
    const waiting = container.querySelectorAll('[data-member-state="waiting"]')
    expect(waiting).toHaveLength(1)
    expect(waiting[0].querySelector(".bg-approval")).toBeInTheDocument()
    expect(container.querySelectorAll('[data-member-state="done"] .bg-approval')).toHaveLength(0)
  })

  it("names the review gate in front of the push", () => {
    render(<AgentRosterReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.agents.reviewBody)).toBeInTheDocument()
  })

  it("has one roster entry per member in both locales", () => {
    expect(en.reconstruction.agents.members).toHaveLength(ROSTER.length)
    expect(zh.reconstruction.agents.members).toHaveLength(ROSTER.length)
  })

  it("localises", () => {
    render(<AgentRosterReconstruction copy={zh.reconstruction} />)
    expect(screen.getByText(zh.reconstruction.agents.reviewLabel)).toBeInTheDocument()
    expect(screen.getAllByText(zh.reconstruction.agents.leadLabel).length).toBeGreaterThan(0)
  })
})
