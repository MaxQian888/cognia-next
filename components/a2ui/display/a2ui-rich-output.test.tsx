import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { A2UIRichOutput } from "./a2ui-rich-output"
import type { A2UIComponentProps, A2UIRichOutputComponent } from "@/types/a2ui/schema"
import { richOutputFixtures } from "@/lib/a2ui/rich-output-fixtures"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      previous: "Previous",
      next: "Next",
      richOutputFallback: "Fallback",
      richOutputUnavailable: "Unavailable",
    })[key] || key,
}))

jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({
    artifact,
  }: {
    artifact: {
      type: string
      title: string
      metadata?: {
        outputProfileId?: string
        hostStrategy?: string
        widget?: { theme?: string; sizing?: string }
      }
    }
  }) => (
    <div
      data-testid="artifact-preview"
      data-type={artifact.type}
      data-profile={artifact.metadata?.outputProfileId}
      data-host-strategy={artifact.metadata?.hostStrategy}
      data-widget-theme={artifact.metadata?.widget?.theme}
      data-widget-sizing={artifact.metadata?.widget?.sizing}
    >
      {artifact.title}
    </div>
  ),
}))

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

jest.mock(
  "../rich-output/chartjs-rich-output",
  () => ({
    ChartJsRichOutput: () => <div data-testid="chartjs-rich-output">Chart.js Runtime</div>,
  }),
  { virtual: true }
)

jest.mock(
  "../rich-output/canvas-simulation-rich-output",
  () => ({
    CanvasSimulationRichOutput: () => (
      <div data-testid="canvas-simulation-rich-output">Canvas Simulation</div>
    ),
  }),
  { virtual: true }
)

jest.mock(
  "../rich-output/three-scene-rich-output",
  () => ({
    ThreeSceneRichOutput: () => <div data-testid="three-scene-rich-output">Three Scene</div>,
  }),
  { virtual: true }
)

jest.mock(
  "../rich-output/tone-synth-rich-output",
  () => ({
    ToneSynthRichOutput: () => <div data-testid="tone-synth-rich-output">Tone Synth</div>,
  }),
  { virtual: true }
)

jest.mock(
  "../rich-output/d3-force-graph-rich-output",
  () => ({
    D3ForceGraphRichOutput: () => (
      <div data-testid="d3-force-graph-rich-output">D3 Force Graph</div>
    ),
  }),
  { virtual: true }
)

jest.mock(
  "../rich-output/svg-plotter-rich-output",
  () => ({
    SvgPlotterRichOutput: () => <div data-testid="svg-plotter-rich-output">SVG Plotter</div>,
  }),
  { virtual: true }
)

jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
}))

function createProps(
  componentOverrides: Partial<A2UIRichOutputComponent> = {},
  dataModel: Record<string, unknown> = {}
): A2UIComponentProps<A2UIRichOutputComponent> {
  return {
    component: {
      id: "rich-output-1",
      component: "RichOutput",
      profileId: "quick-factual-answer",
      title: "Quick Answer",
      content: "Rich output ready.",
      ...componentOverrides,
    } as A2UIRichOutputComponent,
    surfaceId: "surface-1",
    dataModel,
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  }
}

describe("A2UIRichOutput", () => {
  it("renders native plain text content for direct responses", () => {
    render(<A2UIRichOutput {...createProps()} />)

    expect(screen.getByText("Quick Answer")).toBeInTheDocument()
    expect(screen.getByText("Rich output ready.")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-preview")).not.toBeInTheDocument()
  })

  it("uses artifact preview hosting for SVG-based profiles", () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "how-it-works-physical",
          title: "Physical System",
          content: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
        })}
      />
    )

    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-type", "svg")
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute(
      "data-profile",
      "how-it-works-physical"
    )
  })

  it("uses artifact preview hosting for Mermaid relationship profiles", () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: richOutputFixtures.mermaidSchema.profileId,
          title: richOutputFixtures.mermaidSchema.title,
          content: richOutputFixtures.mermaidSchema.content,
        })}
      />
    )

    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-type", "mermaid")
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute(
      "data-profile",
      "database-schema-erd"
    )
  })

  it("uses artifact preview hosting for raw HTML dashboard fixtures", () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: richOutputFixtures.htmlDashboard.profileId,
          title: richOutputFixtures.htmlDashboard.title,
          content: richOutputFixtures.htmlDashboard.content,
          items: [],
        })}
      />
    )

    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-type", "html")
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-profile", "kpis-metrics")
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute(
      "data-host-strategy",
      "sandboxed-html"
    )
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute(
      "data-widget-sizing",
      "content-height"
    )
  })

  it("renders rich output inside the shared widget shell", () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "quick-factual-answer",
          title: "Shell Title",
          content: "Wrapped content",
        })}
      />
    )

    expect(screen.getByTestId("a2ui-widget-shell")).toBeInTheDocument()
    expect(screen.getByText("Shell Title")).toBeInTheDocument()
    expect(screen.getByText("native")).toBeInTheDocument()
  })

  it("renders native metric cards when KPI items are provided", () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "kpis-metrics",
          title: "Metrics",
          items: [
            { id: "m1", title: "Users", value: "128K" },
            { id: "m2", title: "Growth", value: "+24%" },
          ],
        })}
      />
    )

    expect(screen.getByText("Users")).toBeInTheDocument()
    expect(screen.getByText("128K")).toBeInTheDocument()
    expect(screen.getByText("Growth")).toBeInTheDocument()
    expect(screen.getByText("+24%")).toBeInTheDocument()
  })

  it("emits data-change and action events for step-through profiles", () => {
    const props = createProps(
      {
        profileId: "cyclic-process",
        title: "Cycle",
        steps: [
          { id: "step-1", title: "Plan", description: "Define the path." },
          { id: "step-2", title: "Build", description: "Create the result." },
        ],
        currentStep: { path: "/stepIndex" },
        currentStepPath: "/stepIndex",
        stepChangeAction: "step_change",
      },
      { stepIndex: 0 }
    )

    render(<A2UIRichOutput {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    expect(props.onDataChange).toHaveBeenCalledWith("/stepIndex", 1)
    expect(props.onAction).toHaveBeenCalledWith("step_change", {
      profileId: "cyclic-process",
      stepId: "step-2",
      stepIndex: 1,
    })
  })

  it("renders the Chart.js runtime for chart-oriented advanced profiles", async () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "trends-over-time",
          title: "Trend",
          chartData: {
            labels: ["Jan", "Feb"],
            datasets: [{ label: "Users", data: [12, 18] }],
          },
          allowAdvancedProfiles: true,
        })}
      />
    )

    expect(await screen.findByTestId("chartjs-rich-output")).toBeInTheDocument()
  })

  it("renders sortable table data and emits sort events for exploration profiles", () => {
    const props = createProps(
      {
        profileId: "data-exploration",
        title: "Exploration",
        tableColumns: [
          { key: "name", label: "Name" },
          { key: "value", label: "Value", numeric: true },
        ],
        tableRows: [
          { id: "r1", name: "Alpha", value: 10 },
          { id: "r2", name: "Beta", value: 20 },
        ],
        sortKeyPath: "/sort/key",
        sortDirectionPath: "/sort/direction",
        sortAction: "sort_rows",
      },
      {
        sort: {
          key: "name",
          direction: "asc",
        },
      }
    )

    render(<A2UIRichOutput {...props} />)
    // After the DataExplorer → Table merge, the sortable header is a `<th>`
    // with an onClick handler (shadcn Table) rather than a wrapped button.
    const valueHeader = screen.getByText("Value").closest("th")
    expect(valueHeader).not.toBeNull()
    fireEvent.click(valueHeader as HTMLElement)

    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(props.onDataChange).toHaveBeenCalledWith("/sort/key", "value")
    expect(props.onDataChange).toHaveBeenCalledWith("/sort/direction", "asc")
    expect(props.onAction).toHaveBeenCalledWith("sort_rows", {
      direction: "asc",
      key: "value",
      profileId: "data-exploration",
    })
  })

  it("renders the canvas simulation runtime for simulation profiles", async () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "physics-math-simulation",
          title: "Simulation",
          simulationConfig: { amplitude: 24, frequency: 2 },
          allowAdvancedProfiles: true,
        })}
      />
    )

    expect(await screen.findByTestId("canvas-simulation-rich-output")).toBeInTheDocument()
  })

  it("renders the Three.js runtime for 3D profiles", async () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "3d-visualization",
          title: "3D Scene",
          scenePrompt: "Render a rotating torus",
          allowAdvancedProfiles: true,
        })}
      />
    )

    expect(await screen.findByTestId("three-scene-rich-output")).toBeInTheDocument()
  })

  it("renders the Tone.js runtime for audio profiles", async () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "music-audio",
          title: "Synth",
          audioPrompt: "Warm ambient synth",
          allowAdvancedProfiles: true,
        })}
      />
    )

    expect(await screen.findByTestId("tone-synth-rich-output")).toBeInTheDocument()
  })

  it("renders the D3 runtime for network graph profiles", async () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "network-graph",
          title: "Network",
          networkNodes: [
            { id: "n1", label: "A" },
            { id: "n2", label: "B" },
          ],
          networkEdges: [{ source: "n1", target: "n2", value: 1 }],
          allowAdvancedProfiles: true,
        })}
      />
    )

    expect(await screen.findByTestId("d3-force-graph-rich-output")).toBeInTheDocument()
  })

  it("renders the SVG plotter runtime for equation plotting profiles", async () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "function-equation-plotter",
          title: "Plotter",
          plotPoints: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 4 },
          ],
          allowAdvancedProfiles: true,
        })}
      />
    )

    expect(await screen.findByTestId("svg-plotter-rich-output")).toBeInTheDocument()
  })

  it("falls back to explicit fallback content when advanced profiles are disabled", () => {
    render(
      <A2UIRichOutput
        {...createProps({
          profileId: "3d-visualization",
          title: "3D Scene",
          fallbackContent: "Switching to a simpler explanation.",
          allowAdvancedProfiles: false,
        })}
      />
    )

    expect(screen.getByText("Switching to a simpler explanation.")).toBeInTheDocument()
    expect(screen.getByText("Fallback")).toBeInTheDocument()
  })
})
