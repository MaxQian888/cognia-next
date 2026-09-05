import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

let reduced = false
let inView = false
jest.mock("motion/react", () => {
  const passthrough = (tag: "ol" | "li" | "span") => {
    function Passthrough({
      children,
      className,
      style,
    }: {
      children?: ReactNode
      className?: string
      style?: React.CSSProperties
    }) {
      const Tag = tag
      return (
        <Tag className={className} style={style}>
          {children}
        </Tag>
      )
    }
    return Passthrough
  }
  return {
    useReducedMotion: () => reduced,
    useInView: () => inView,
    motion: { ol: passthrough("ol"), li: passthrough("li"), span: passthrough("span") },
  }
})

import { FLOW_STEP_MS, SystemFlow } from "./system-flow"

const copy = {
  title: "From trigger to durable record",
  subtitle: "The execution path remains visible at every boundary.",
  steps: [
    {
      key: "trigger",
      label: "Trigger",
      body: "A person, schedule, connector, or agent starts the work.",
      docsPath: "/docs/subsystems/visual-workflows",
    },
    {
      key: "context",
      label: "Context",
      body: "Declared inputs become the run context.",
      docsPath: "/docs/subsystems/visual-workflows/data-model",
    },
    {
      key: "approval",
      label: "Approval",
      body: "A boundary action pauses for a person.",
      docsPath: "/docs/subsystems/unified-agent-execution",
    },
    {
      key: "record",
      label: "Record",
      body: "Every node state remains available after the run.",
      docsPath: "/docs/subsystems/visual-workflows/ui-runs",
    },
  ],
}

describe("SystemFlow", () => {
  it("renders the ordered execution path without hiding any step", () => {
    render(
      <SystemFlow
        copy={copy}
        learnMore="Read the docs"
        locale="en"
        docsOrigin="https://docs.example"
      />
    )

    expect(screen.getByRole("heading", { level: 2, name: copy.title })).toBeInTheDocument()
    const steps = screen.getAllByRole("listitem")
    expect(steps).toHaveLength(4)
    for (const step of copy.steps) {
      expect(screen.getByRole("heading", { level: 3, name: step.label })).toBeInTheDocument()
      expect(screen.getByText(step.body)).toBeInTheDocument()
    }
  })

  it("keeps documentation links on the ordered steps", () => {
    render(
      <SystemFlow
        copy={copy}
        learnMore="Read the docs"
        locale="en"
        docsOrigin="https://docs.example"
      />
    )

    expect(screen.getAllByRole("link")).toHaveLength(copy.steps.length)
  })

  it("renders an additional undocumented boundary without inventing a destination", () => {
    const finalStep = {
      key: "export",
      label: "Export",
      body: "The record can leave the workspace in a documented format.",
    }

    render(
      <SystemFlow
        copy={{ ...copy, steps: [...copy.steps, finalStep] }}
        learnMore="Read the docs"
        locale="en"
      />
    )

    expect(screen.getByRole("heading", { level: 3, name: finalStep.label })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(5)
    expect(screen.getAllByRole("link")).toHaveLength(copy.steps.length)
  })
})

describe("SystemFlow rail", () => {
  beforeEach(() => {
    reduced = false
    inView = false
  })

  const props = {
    copy,
    learnMore: "Read the docs",
    locale: "en" as const,
    docsOrigin: "https://docs.example",
  }

  it("arms nothing until the rail is on screen", () => {
    const { container } = render(<SystemFlow {...props} />)
    expect(container.querySelector('[data-slot="flow-rail"]')).not.toHaveAttribute("data-live")
    expect(container.querySelector('[data-slot="flow-marker"]')).toBeNull()
    expect(container.querySelectorAll(".station-lit")).toHaveLength(0)
  })

  it("sends the marker along the rail and lights each boundary in turn once on screen", () => {
    inView = true
    const { container } = render(<SystemFlow {...props} />)
    expect(container.querySelector('[data-slot="flow-rail"]')).toHaveAttribute("data-live", "true")
    const marker = container.querySelector('[data-slot="flow-marker"]') as HTMLElement
    expect(marker.style.getPropertyValue("--handoff-duration")).toBe(
      `${FLOW_STEP_MS * (copy.steps.length - 1)}ms`
    )
    const stations = [...container.querySelectorAll(".station-lit")] as HTMLElement[]
    expect(stations).toHaveLength(copy.steps.length)
    expect(stations.map((li) => li.style.getPropertyValue("--station-delay"))).toEqual(
      copy.steps.map((_, index) => `${index * FLOW_STEP_MS}ms`)
    )
  })

  it("lights every boundary at once under reduced motion, with no marker", () => {
    inView = true
    reduced = true
    const { container } = render(<SystemFlow {...props} />)
    expect(container.querySelector('[data-slot="flow-marker"]')).toBeNull()
    expect(container.querySelectorAll(".station-lit")).toHaveLength(copy.steps.length)
  })
})
