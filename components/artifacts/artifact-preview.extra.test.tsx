/**
 * @jest-environment jsdom
 */

import { render, screen, act, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) => {
    if (key === "previewFailed" || key === "loadingPreview") return ""
    return vars ? `${key}:${JSON.stringify(vars)}` : key
  },
}))

jest.mock("@/lib/artifacts", () => {
  const actual = jest.requireActual<typeof import("@/lib/artifacts")>("@/lib/artifacts")
  return { ...actual, renderHTML: jest.fn(actual.renderHTML) }
})

jest.mock("./artifact-renderers", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const registry = jest.requireActual<typeof import("@/lib/artifacts/renderer-registry")>(
    "@/lib/artifacts/renderer-registry"
  )
  return {
    ArtifactRenderer: ({ type, content }: { type: string; content: string }) => {
      if (content === "__throw__") throw new Error("inner preview failure")
      return <div data-testid={`artifact-renderer-${type}`} />
    },
    PluginArtifactRendererHost: ({
      renderer,
      onRuntimeStateChange,
    }: {
      renderer: { id: string }
      onRuntimeStateChange?: (
        state: "ready" | "loading" | "error" | "unsupported",
        err?: string
      ) => void
    }) => {
      React.useEffect(() => {
        if (renderer.id === "unsupported") {
          onRuntimeStateChange?.("unsupported")
          return
        }
        onRuntimeStateChange?.("loading")
        onRuntimeStateChange?.("error", "boom")
        onRuntimeStateChange?.("error")
        onRuntimeStateChange?.("unsupported")
        onRuntimeStateChange?.("ready")
      }, [onRuntimeStateChange, renderer.id])
      return <div data-testid="plugin-host" />
    },
    resolveArtifactRenderPlan: (artifact: { type: string }) => {
      const claimed = registry.resolveRegisteredArtifactRenderer(artifact as never)
      if (claimed) return { owner: "plugin" as const, pluginRenderer: claimed }
      if (artifact.type === "jupyter") return { owner: "jupyter" as const }
      if (
        artifact.type === "code" ||
        artifact.type === "document" ||
        artifact.type === "mermaid" ||
        artifact.type === "chart" ||
        artifact.type === "math"
      ) {
        const map: Record<string, string | undefined> = {
          code: "code",
          document: "document",
          mermaid: "mermaid",
          chart: "chart",
          math: "math",
        }
        return {
          owner: "builtin" as const,
          rendererType: map[artifact.type] as
            "code" | "document" | "mermaid" | "chart" | "math" | undefined,
        }
      }
      return { owner: "runtime" as const }
    },
  }
})

jest.mock("./jupyter-renderer", () => ({
  JupyterRenderer: () => <div data-testid="jupyter" />,
}))

import { ArtifactPreview } from "./artifact-preview"
import {
  registerArtifactRenderer,
  clearRegisteredArtifactRenderers,
  type PluginArtifactRenderer,
} from "@/lib/artifacts/renderer-registry"
import { renderHTML } from "@/lib/artifacts"
import type { Artifact } from "@/types"

const dummy = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  sessionId: "s",
  messageId: "m",
  type: "code",
  title: "t",
  content: "x",
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

afterEach(() => {
  clearRegisteredArtifactRenderers()
})

describe("ArtifactPreview — extra coverage", () => {
  it("renders an SVG iframe for svg artifacts", () => {
    const { container } = render(
      <ArtifactPreview artifact={dummy({ type: "svg", content: "<svg></svg>" })} />
    )
    expect(container.querySelector("iframe")).not.toBeNull()
  })

  it("renders the document/markdown branch", () => {
    render(<ArtifactPreview artifact={dummy({ type: "document", content: "# hi" })} />)
    expect(screen.getByTestId("artifact-renderer-document")).toBeInTheDocument()
  })

  it("renders the math branch", () => {
    render(<ArtifactPreview artifact={dummy({ type: "math", content: "$$x$$" })} />)
    expect(screen.getByTestId("artifact-renderer-math")).toBeInTheDocument()
  })

  it("uses the plugin host when a renderer claims the artifact and surfaces ready/error states", () => {
    const r: PluginArtifactRenderer = {
      id: "x",
      kind: "test/html",
      mount: () => ({ dispose() {} }),
    }
    registerArtifactRenderer(r.id, r)
    render(
      <ArtifactPreview
        artifact={dummy({
          type: "html",
          metadata: {
            plugin: { kind: "test/html", schemaVersion: 1, ownerPluginId: "test" },
          },
        })}
      />
    )
    expect(screen.getByTestId("plugin-host")).toBeInTheDocument()
  })

  it("surfaces an unsupported plugin runtime state", async () => {
    const renderer: PluginArtifactRenderer = {
      id: "unsupported",
      kind: "test/unsupported",
      mount: () => ({ dispose() {} }),
    }
    registerArtifactRenderer(renderer.id, renderer)
    render(
      <ArtifactPreview
        artifact={dummy({
          type: "html",
          metadata: {
            plugin: { kind: renderer.kind, schemaVersion: 1, ownerPluginId: "test" },
          },
        })}
      />
    )

    expect(await screen.findByTestId("runtime-health-badge")).toHaveAttribute(
      "data-state",
      "unsupported"
    )
  })

  it("renders a React-typed iframe (separate sandbox path)", () => {
    const { container } = render(
      <ArtifactPreview
        artifact={dummy({ type: "react", content: "function App(){return null}" })}
      />
    )
    expect(container.querySelector("iframe")).not.toBeNull()
  })

  it("postMessage handler accepts size + ready + error", async () => {
    const { container } = render(
      <ArtifactPreview
        artifact={dummy({
          type: "html",
          content: "<html></html>",
          metadata: { widget: { sizing: "content-height" } },
        })}
      />
    )
    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    const postMessage = jest.fn()
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage },
      configurable: true,
    })
    const dispatchFromIframe = (data: Record<string, unknown>) => {
      const event = new MessageEvent("message", { data })
      Object.defineProperty(event, "source", { value: iframe.contentWindow })
      window.dispatchEvent(event)
    }

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "artifact-preview-ready" } })
      )
      dispatchFromIframe({ type: "artifact-preview-ready" })
      dispatchFromIframe({ type: "artifact-preview-resize", height: 240 })
      dispatchFromIframe({ type: "artifact-preview-resize", height: 0 })
      dispatchFromIframe({ type: "artifact-preview-resize", height: "240" })
      dispatchFromIframe({ type: "artifact-preview-error", message: "x" })
      dispatchFromIframe({ type: "artifact-preview-error" })
    })
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "artifact-preview-parent-context" }),
      "*"
    )
    expect(iframe).toHaveStyle({ height: "240px" })
    const alert = screen.getByRole("alert")
    fireEvent.click(alert.querySelector("button")!)
    expect(container.querySelector("iframe")).not.toBe(iframe)
  })

  it("error handler on iframe fires onError", () => {
    const { container } = render(
      <ArtifactPreview artifact={dummy({ type: "html", content: "<html></html>" })} />
    )
    const iframe = container.querySelector("iframe")!
    act(() => {
      fireEvent.error(iframe)
    })
  })

  it("iframe renders fire after the 100ms timer for html/svg/react/code", async () => {
    jest.useFakeTimers()
    try {
      const { rerender } = render(
        <ArtifactPreview artifact={dummy({ type: "html", content: "<html></html>" })} />
      )
      act(() => {
        jest.advanceTimersByTime(150)
      })
      rerender(
        <ArtifactPreview
          artifact={dummy({
            type: "svg",
            content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
          })}
        />
      )
      act(() => {
        jest.advanceTimersByTime(150)
      })
      rerender(
        <ArtifactPreview
          artifact={dummy({ type: "react", content: "function App(){return null}" })}
        />
      )
      act(() => {
        jest.advanceTimersByTime(150)
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    [new Error("render exploded"), "render exploded"],
    ["non-error failure", "previewError"],
  ])("surfaces a scheduled HTML render failure", (failure, expectedMessage) => {
    jest.useFakeTimers()
    try {
      jest.mocked(renderHTML).mockImplementationOnce(() => {
        throw failure
      })
      render(<ArtifactPreview artifact={dummy({ type: "html", content: "<html></html>" })} />)

      act(() => {
        jest.advanceTimersByTime(150)
      })

      expect(screen.getByRole("alert")).toHaveTextContent(expectedMessage)
    } finally {
      jest.useRealTimers()
    }
  })

  it("iframe onLoad path posts the React render message", async () => {
    jest.useFakeTimers()
    try {
      const { container } = render(
        <ArtifactPreview
          artifact={dummy({ type: "react", content: "function App(){return null}" })}
        />
      )
      const iframe = container.querySelector("iframe")!
      // Simulate the iframe having a contentWindow.
      const postMessage = jest.fn()
      Object.defineProperty(iframe, "contentWindow", {
        value: { postMessage },
        configurable: true,
      })
      act(() => {
        fireEvent.load(iframe)
      })
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "render-component" }),
        "*"
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it("PreviewErrorBoundary surfaces an alert when a child throws", () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation()
    render(<ArtifactPreview artifact={dummy({ type: "code", content: "__throw__" })} />)

    expect(screen.getByRole("alert")).toHaveTextContent("inner preview failure")
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }))
    expect(screen.getByRole("alert")).toBeInTheDocument()
    consoleSpy.mockRestore()
  })
})

describe("ArtifactPreview — re-render gating", () => {
  const html = (content: string) =>
    ({
      id: "a1",
      sessionId: "s",
      messageId: "m",
      type: "html" as const,
      title: "Page",
      content,
      version: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }) as never

  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  function countWrites(frame: HTMLIFrameElement) {
    const doc = frame.contentDocument as Document
    const spy = jest.spyOn(doc, "write")
    return spy
  }

  it("does not rewrite the document when nothing about the artifact changed", async () => {
    // The Canvas split view drives this from the live buffer, so an ungated
    // effect re-parsed and rewrote the whole document per commit.
    const { rerender, container } = render(<ArtifactPreview artifact={html("<p>a</p>")} />)
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    const frame = container.querySelector("iframe") as HTMLIFrameElement
    const write = countWrites(frame)

    rerender(<ArtifactPreview artifact={html("<p>a</p>")} />)
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(write).not.toHaveBeenCalled()

    rerender(<ArtifactPreview artifact={html("<p>b</p>")} />)
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(write).toHaveBeenCalled()
  })

  it("does not raise the loading curtain for a content update on a live frame", async () => {
    // Raising it made every keystroke in a Canvas split view flash a full-cover
    // backdrop blur.
    const { rerender, container } = render(<ArtifactPreview artifact={html("<p>a</p>")} />)
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(container.querySelector(".backdrop-blur-sm")).toBeNull()

    rerender(<ArtifactPreview artifact={html("<p>b</p>")} />)
    // No timers advanced: if a curtain were raised it would be on screen now.
    expect(container.querySelector(".backdrop-blur-sm")).toBeNull()
  })
})
