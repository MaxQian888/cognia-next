import { render, screen, within } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { HeroTaskTicket } from "./hero-task-ticket"

function renderTicket(copy = en) {
  return render(
    <HeroTaskTicket copy={copy.home.hero.ticket} reconstruction={copy.reconstruction} />
  )
}

describe("HeroTaskTicket", () => {
  it("states the task's identity from the shared fixture", () => {
    renderTicket()
    expect(screen.getByText(DEMO_TASK.repository)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.branch)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.check)).toBeInTheDocument()
  })

  it("makes no claim of its own — every value comes from copy already on the page", () => {
    // The ticket exists to move the page's argument onto the first screen, not
    // to add a new one. If it ever renders a value that is not in the fixture
    // or the reconstruction copy, that is a new factual claim.
    renderTicket()
    for (const item of DEMO_TASK.plan) {
      expect(
        screen.getByText(en.reconstruction.artifacts.plan.items[item.key].text)
      ).toBeInTheDocument()
    }
    expect(screen.getByText(en.reconstruction.workbench.statusLine)).toBeInTheDocument()
  })

  it("lists the plan in the fixture's order", () => {
    renderTicket()
    const rendered = screen.getAllByRole("listitem").map((li) => li.textContent ?? "")
    expect(rendered).toHaveLength(DEMO_TASK.plan.length)
    DEMO_TASK.plan.forEach((item, index) => {
      expect(rendered[index]).toContain(en.reconstruction.artifacts.plan.items[item.key].text)
    })
  })

  it("names each plan state in words, not only by colour", () => {
    // Spec §8: state must never rest on colour alone.
    renderTicket()
    const labels = en.reconstruction.artifacts.plan.stateLabels
    for (const item of DEMO_TASK.plan) {
      const state = en.reconstruction.artifacts.plan.items[item.key].state
      const row = screen
        .getByText(en.reconstruction.artifacts.plan.items[item.key].text)
        .closest("li")
      expect(row).not.toBeNull()
      expect(within(row as HTMLElement).getByText(labels[state])).toBeInTheDocument()
    }
  })

  it("passes a layout class through", () => {
    const { container } = render(
      <HeroTaskTicket
        copy={en.home.hero.ticket}
        reconstruction={en.reconstruction}
        className="my-class"
      />
    )
    expect(container.querySelector(".my-class")).toBeInTheDocument()
  })

  it("keeps its decorative marks out of the accessibility tree", () => {
    const { container } = renderTicket()
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true")
    }
  })

  it("localises", () => {
    renderTicket(zh)
    expect(screen.getByText(zh.home.hero.ticket.label)).toBeInTheDocument()
    expect(screen.getByText(zh.reconstruction.workbench.statusLine)).toBeInTheDocument()
    // The identity is locale-invariant by design and must not be translated.
    expect(screen.getByText(DEMO_TASK.repository)).toBeInTheDocument()
  })
})
