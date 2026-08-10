import { render, screen } from "@testing-library/react"

import { SystemFlow } from "./system-flow"

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
