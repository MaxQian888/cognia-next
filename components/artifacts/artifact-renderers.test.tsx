/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code" data-language={language ?? ""}>
      {code}
    </pre>
  ),
}))
jest.mock("@/components/chat/renderers/math-block", () => ({
  MathBlock: ({ content }: { content: string }) => <div data-testid="math">{content}</div>,
}))
jest.mock("@/components/chat/renderers/mermaid-block", () => ({
  MermaidBlock: ({ content }: { content: string }) => <div data-testid="mermaid">{content}</div>,
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))
jest.mock("./chart-renderer", () => ({
  ChartRenderer: ({ content }: { content: string }) => <div data-testid="chart">{content}</div>,
}))

import {
  resolveArtifactRenderPlan,
  ArtifactRenderer,
  ChartRenderer,
  PluginArtifactRendererHost,
} from "./artifact-renderers"
import {
  registerArtifactRenderer,
  clearRegisteredArtifactRenderers,
  type PluginArtifactRenderer,
} from "@/lib/artifacts/renderer-registry"
import type { Artifact } from "@/types"

const dummy = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  sessionId: "s",
  messageId: "m",
  type: "code",
  title: "t",
  content: "console.log(1)",
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

async function flushRendererState(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  clearRegisteredArtifactRenderers()
})

describe("resolveArtifactRenderPlan", () => {
  it("returns 'plugin' when a plugin renderer claims the artifact", () => {
    const r: PluginArtifactRenderer = {
      id: "x",
      kind: "test/workbook",
      mount: () => ({ dispose: () => {} }),
    }
    registerArtifactRenderer("x", r)
    const plan = resolveArtifactRenderPlan(
      dummy({
        metadata: { plugin: { kind: "test/workbook", schemaVersion: 1, ownerPluginId: "test" } },
      })
    )
    expect(plan.owner).toBe("plugin")
    expect(plan.pluginRenderer).toBe(r)
  })

  it("returns 'jupyter' for jupyter type", () => {
    expect(resolveArtifactRenderPlan(dummy({ type: "jupyter" })).owner).toBe("jupyter")
  })

  it("returns 'builtin' for renderer-transport types", () => {
    expect(resolveArtifactRenderPlan(dummy({ type: "code" })).owner).toBe("builtin")
    expect(resolveArtifactRenderPlan(dummy({ type: "mermaid" })).owner).toBe("builtin")
  })

  it("returns 'runtime' for iframe-transport types", () => {
    expect(resolveArtifactRenderPlan(dummy({ type: "html" })).owner).toBe("runtime")
    expect(resolveArtifactRenderPlan(dummy({ type: "react" })).owner).toBe("runtime")
  })
})

describe("ArtifactRenderer", () => {
  it("dispatches to MermaidBlock for mermaid type", () => {
    render(<ArtifactRenderer type="mermaid" content="graph TD" />)
    expect(screen.getByTestId("mermaid")).toBeInTheDocument()
  })

  it("dispatches to MathBlock for math", () => {
    render(<ArtifactRenderer type="math" content="$$x$$" />)
    expect(screen.getByTestId("math")).toBeInTheDocument()
  })

  it("dispatches to MarkdownRenderer for documents", () => {
    render(<ArtifactRenderer type="document" content="# hi" />)
    expect(screen.getByTestId("md")).toBeInTheDocument()
  })

  it("dispatches to CodeBlock for code", () => {
    render(<ArtifactRenderer type="code" content="x" />)
    expect(screen.getByTestId("code")).toBeInTheDocument()
  })

  it("dispatches to CodeBlock for unknown types", () => {
    render(<ArtifactRenderer type="weird" content="x" />)
    expect(screen.getByTestId("code")).toBeInTheDocument()
  })

  it("forwards the artifact language to CodeBlock so syntax highlighting can run", () => {
    // Regression: the code/default cases rendered <CodeBlock> with no language,
    // so the highlighter never ran and the artifact code view fell back to
    // colourless plain text. The language must reach CodeBlock (mapped to its
    // Shiki id) for syntax colour to render.
    render(
      <ArtifactRenderer
        type="code"
        content="const x = 1"
        artifact={dummy({ language: "typescript" })}
      />
    )
    expect(screen.getByTestId("code")).toHaveAttribute("data-language", "typescript")
  })

  it("forwards the artifact language for unknown types too", () => {
    render(<ArtifactRenderer type="weird" content="x" artifact={dummy({ language: "python" })} />)
    expect(screen.getByTestId("code")).toHaveAttribute("data-language", "python")
  })

  it("dispatches to ChartRenderer for charts", async () => {
    render(<ArtifactRenderer type="chart" content="[]" />)
    // ChartRenderer is wrapped in Suspense+lazy; wait for the mocked module.
    expect(await screen.findByTestId("chart")).toBeInTheDocument()
  })

  it("ChartRenderer wrapper component renders the lazy child", () => {
    const { container } = render(<ChartRenderer content="[]" />)
    expect(container.firstChild).not.toBeNull()
  })

  it("mounts visible plugin output and disposes it on unmount", async () => {
    const dispose = jest.fn()
    const r: PluginArtifactRenderer = {
      id: "x",
      kind: "test/workbook",
      mount: (_artifact, container) => {
        container.textContent = "Workbook preview"
        return { dispose }
      },
    }
    registerArtifactRenderer("x", r)
    const a = dummy({
      metadata: { plugin: { kind: "test/workbook", schemaVersion: 1, ownerPluginId: "test" } },
    })
    const view = render(<ArtifactRenderer type="code" content={a.content} artifact={a} />)
    await flushRendererState()
    expect(screen.getByText("Workbook preview")).toBeInTheDocument()
    view.unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("updates an existing plugin renderer handle when artifact content changes", async () => {
    const update = jest.fn()
    const mount = jest.fn((_artifact: Artifact, container: HTMLElement) => {
      container.textContent = "Workbook preview"
      return { update, dispose: jest.fn() }
    })
    const renderer: PluginArtifactRenderer = {
      id: "test/workbook",
      kind: "test/workbook",
      mount,
    }
    registerArtifactRenderer(renderer.id, renderer)
    const first = dummy({
      metadata: { plugin: { kind: "test/workbook", schemaVersion: 1, ownerPluginId: "test" } },
    })
    const view = render(<ArtifactRenderer type="code" content={first.content} artifact={first} />)
    await flushRendererState()
    const second = { ...first, content: "updated", version: 2 }

    view.rerender(<ArtifactRenderer type="code" content={second.content} artifact={second} />)
    await flushRendererState()

    expect(mount).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(second)
  })

  it("remounts and disposes when the renderer does not implement update", async () => {
    const dispose = jest.fn()
    const mount = jest.fn((_artifact: Artifact, container: HTMLElement) => {
      container.textContent = "Workbook preview"
      return { dispose }
    })
    const renderer: PluginArtifactRenderer = {
      id: "test/workbook",
      kind: "test/workbook",
      mount,
    }
    registerArtifactRenderer(renderer.id, renderer)
    const first = dummy({
      metadata: { plugin: { kind: "test/workbook", schemaVersion: 1, ownerPluginId: "test" } },
    })
    const view = render(<ArtifactRenderer type="code" content={first.content} artifact={first} />)
    await flushRendererState()

    view.rerender(
      <ArtifactRenderer
        type="code"
        content="updated"
        artifact={{ ...first, content: "updated", version: 2 }}
      />
    )
    await flushRendererState()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledTimes(2)
  })

  it("shows the host error state and fallback when mount fails", async () => {
    const renderer: PluginArtifactRenderer = {
      id: "test/workbook",
      kind: "test/workbook",
      mount: () => {
        throw new Error("renderer exploded")
      },
    }
    registerArtifactRenderer(renderer.id, renderer)
    const workbook = dummy({
      metadata: { plugin: { kind: "test/workbook", schemaVersion: 1, ownerPluginId: "test" } },
    })

    render(<ArtifactRenderer type="code" content={workbook.content} artifact={workbook} />)

    expect(await screen.findByText("renderer exploded")).toBeInTheDocument()
    expect(screen.getByTestId("code")).toHaveTextContent(workbook.content)
  })

  it("contains disposer failures instead of crashing host teardown", async () => {
    const onRuntimeStateChange = jest.fn()
    const renderer: PluginArtifactRenderer = {
      id: "test/workbook",
      kind: "test/workbook",
      mount: (_artifact, container) => {
        container.textContent = "Workbook preview"
        return {
          dispose: () => {
            throw new Error("dispose exploded")
          },
        }
      },
    }
    registerArtifactRenderer(renderer.id, renderer)
    const workbook = dummy({
      metadata: { plugin: { kind: "test/workbook", schemaVersion: 1, ownerPluginId: "test" } },
    })
    const view = render(
      <PluginArtifactRendererHost
        artifact={workbook}
        renderer={renderer}
        onRuntimeStateChange={onRuntimeStateChange}
      />
    )
    await flushRendererState()

    expect(() => view.unmount()).not.toThrow()
    await waitFor(() =>
      expect(onRuntimeStateChange).toHaveBeenCalledWith("error", "dispose exploded")
    )
  })
})
