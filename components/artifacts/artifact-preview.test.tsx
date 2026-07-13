/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./artifact-renderers", () => ({
  ArtifactRenderer: ({ type }: { type: string }) => (
    <div data-testid={`artifact-renderer-${type}`} />
  ),
  PluginArtifactRendererHost: () => <div data-testid="plugin-host" />,
  // Inline implementation so we don't have to evaluate the real module
  // (which transitively pulls shiki — an ESM that Jest can't load).
  resolveArtifactRenderPlan: (artifact: { type: string }) => {
    if (artifact.type === "jupyter") return { owner: "jupyter" as const }
    if (
      artifact.type === "code" ||
      artifact.type === "document" ||
      artifact.type === "mermaid" ||
      artifact.type === "chart" ||
      artifact.type === "math"
    ) {
      const rendererTypeMap: Record<string, string | undefined> = {
        code: "code",
        document: "document",
        mermaid: "mermaid",
        chart: "chart",
        math: "math",
      }
      return {
        owner: "builtin" as const,
        rendererType: rendererTypeMap[artifact.type] as
          "code" | "document" | "mermaid" | "chart" | "math" | undefined,
      }
    }
    return { owner: "runtime" as const }
  },
}))

jest.mock("./jupyter-renderer", () => ({
  JupyterRenderer: ({ content }: { content: string }) => (
    <div data-testid="jupyter">{content.slice(0, 8)}</div>
  ),
}))

import { ArtifactPreview } from "./artifact-preview"
import { loggers } from "@cognia/logging"
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

describe("ArtifactPreview", () => {
  it("delegates to a built-in renderer for code", () => {
    render(<ArtifactPreview artifact={dummy({ type: "code" })} />)
    expect(screen.getByTestId("artifact-renderer-code")).toBeInTheDocument()
  })

  it("delegates to ChartRenderer for chart artifacts", () => {
    render(<ArtifactPreview artifact={dummy({ type: "chart" })} />)
    expect(screen.getByTestId("artifact-renderer-chart")).toBeInTheDocument()
  })

  it("renders the JupyterRenderer for jupyter artifacts", () => {
    render(<ArtifactPreview artifact={dummy({ type: "jupyter", content: "{}" })} />)
    expect(screen.getByTestId("jupyter")).toBeInTheDocument()
  })

  it("renders an iframe sandbox for HTML artifacts", () => {
    const { container } = render(
      <ArtifactPreview artifact={dummy({ type: "html", content: "<html></html>" })} />
    )
    expect(container.querySelector("iframe")).not.toBeNull()
  })

  it("uses a React iframe shell for react artifacts", async () => {
    const { container } = render(
      <ArtifactPreview artifact={dummy({ type: "react", content: "function App(){}" })} />
    )
    const iframe = container.querySelector("iframe") as HTMLIFrameElement | null
    expect(iframe).not.toBeNull()
    // The renderer schedules srcdoc population after a queueMicrotask + rAF in
    // production. waitFor polls until React's effect runs without race conditions.
    await waitFor(() => {
      expect(iframe!.srcdoc).toMatch(/cdnLoadTitle/)
    })
  })

  it("logs a warning when the iframe posts an artifact-preview-error", () => {
    const warnSpy = jest.spyOn(loggers.ui, "warn").mockImplementation()
    const { container } = render(
      <ArtifactPreview artifact={dummy({ type: "html", content: "<html></html>" })} />
    )
    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    // Dispatch a fake "artifact-preview-error" message originating from the iframe.
    const event = new MessageEvent("message", {
      data: { type: "artifact-preview-error", message: "boom" },
      source: iframe.contentWindow,
    })
    Object.defineProperty(event, "source", { value: iframe.contentWindow })
    window.dispatchEvent(event)
    expect(warnSpy).toHaveBeenCalledWith(
      "artifacts.preview.iframe-error",
      expect.objectContaining({ message: "boom" })
    )
    warnSpy.mockRestore()
  })
})
