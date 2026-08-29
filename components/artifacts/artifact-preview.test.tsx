/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

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

const mockSettings: { artifacts?: { interactiveHtml?: boolean } } = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (state: { settings: typeof mockSettings }) => T) =>
    selector({ settings: mockSettings }),
}))

const transformArtifactJsx = jest.fn(async (code: string) => ({ code, isModule: false }))
const loadArtifactReactRuntime = jest.fn(async () => ({
  origin: "https://app.test",
  reactRuntimeUrl: "https://app.test/artifact-runtime/react-runtime.js",
  shellUrl: "https://app.test/artifact-runtime/artifact-shell.js",
  reactVersion: "19.2.8",
}))
jest.mock("@/lib/artifacts/react-runtime-loader", () => ({
  loadArtifactReactRuntime: (...args: unknown[]) => loadArtifactReactRuntime(...(args as [])),
  transformArtifactJsx: (...args: [string]) => transformArtifactJsx(...args),
}))

jest.mock("./jupyter-renderer", () => ({
  JupyterRenderer: ({ content }: { content: string }) => (
    <div data-testid="jupyter">{content.slice(0, 8)}</div>
  ),
}))

import { ArtifactPreview } from "./artifact-preview"
import { loggers } from "@cognia/logging"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
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

beforeEach(() => {
  transformArtifactJsx.mockClear()
  loadArtifactReactRuntime.mockClear()
  delete mockSettings.artifacts
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

  it("updates diagram theme variables without regenerating iframe content", async () => {
    document.documentElement.style.setProperty("--primary", "#3366ff")
    const { container } = render(
      <ArtifactPreview
        artifact={dummy({
          type: "html",
          content: "<html><body><p id='diagram-node'>diagram</p></body></html>",
          metadata: { rendererProfile: "diagram-design-v1" },
        })}
      />
    )
    const iframe = container.querySelector("iframe") as HTMLIFrameElement

    await waitFor(() =>
      expect(iframe.contentDocument?.documentElement.style.getPropertyValue("--primary")).toBe(
        "#3366ff"
      )
    )
    const diagramNode = iframe.contentDocument?.getElementById("diagram-node")

    document.documentElement.style.setProperty("--primary", "#ff3366")

    await waitFor(() =>
      expect(iframe.contentDocument?.documentElement.style.getPropertyValue("--primary")).toBe(
        "#ff3366"
      )
    )
    expect(iframe.contentDocument?.getElementById("diagram-node")).toBe(diagramNode)
    document.documentElement.style.removeProperty("--primary")
  })

  it("serves the React shell from the local runtime, with no external origin", async () => {
    const { container } = render(
      <ArtifactPreview artifact={dummy({ type: "react", content: "function App(){}" })} />
    )
    const iframe = container.querySelector("iframe") as HTMLIFrameElement | null
    expect(iframe).not.toBeNull()
    // The renderer schedules srcdoc population after a queueMicrotask + rAF in
    // production. waitFor polls until React's effect runs without race conditions.
    await waitFor(() => expect(loadArtifactReactRuntime).toHaveBeenCalled())
    await waitFor(() => {
      expect(iframe!.srcdoc).toContain("/artifact-runtime/react-runtime.js")
    })
    expect(iframe!.srcdoc).toContain("/artifact-runtime/artifact-shell.js")
    // React 19 publishes no UMD build; the CDN tags this replaced were a 404.
    expect(iframe!.srcdoc).not.toMatch(/unpkg\.com|cdn\.tailwindcss\.com/)
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts")
  })

  it("pushes transformed code only after the frame's bootstrap says it is listening", async () => {
    const { container } = render(
      <ArtifactPreview artifact={dummy({ type: "react", content: "const App = () => <p/>" })} />
    )
    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    await waitFor(() => expect(iframe.srcdoc).toContain("artifact-shell.js"))
    // Nothing is pushed on `load`: the script tags may still be executing.
    expect(transformArtifactJsx).not.toHaveBeenCalled()

    const post = jest.fn()
    const frameWindow = iframe.contentWindow as Window
    frameWindow.postMessage = post
    const event = new MessageEvent("message", { data: { type: "artifact-shell-ready" } })
    // The host filters by source, exactly as it does for a real frame.
    Object.defineProperty(event, "source", { value: frameWindow })
    window.dispatchEvent(event)

    await waitFor(() => expect(transformArtifactJsx).toHaveBeenCalledWith("const App = () => <p/>"))
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "artifact-shell-config" }),
      expect.objectContaining({ targetOrigin: "*" })
    )
  })

  it("re-renders an edited React artifact in place, without re-navigating the frame", async () => {
    // The old shell built a NEW root per message, so the only way to show an
    // edit was to rebuild the whole document.
    const { container, rerender } = render(
      <ArtifactPreview artifact={dummy({ type: "react", content: "const App = () => 1" })} />
    )
    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    await waitFor(() => expect(iframe.srcdoc).toContain("artifact-shell.js"))
    const frameWindow = iframe.contentWindow as Window
    frameWindow.postMessage = jest.fn()
    const ready = new MessageEvent("message", { data: { type: "artifact-shell-ready" } })
    Object.defineProperty(ready, "source", { value: frameWindow })
    window.dispatchEvent(ready)
    await waitFor(() => expect(transformArtifactJsx).toHaveBeenCalledTimes(1))
    const srcdocBefore = iframe.srcdoc

    rerender(
      <ArtifactPreview artifact={dummy({ type: "react", content: "const App = () => 2" })} />
    )
    await waitFor(() => expect(transformArtifactJsx).toHaveBeenCalledTimes(2))
    expect(container.querySelector("iframe")).toBe(iframe)
    expect(iframe.srcdoc).toBe(srcdocBefore)
  })

  it("surfaces a specific failure when the local runtime is missing", async () => {
    loadArtifactReactRuntime.mockRejectedValueOnce(new Error("gone"))
    render(<ArtifactPreview artifact={dummy({ type: "react", content: "x" })} />)
    // Immediately, not after a 15 second CDN timeout.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("runtimeInitFailed"))
  })

  describe("interactive HTML", () => {
    const scripted = () =>
      dummy({
        id: "html-1",
        type: "html",
        content: `<html><body><button onclick="go()">go</button><script>function go(){}</script></body></html>`,
      })

    it("offers nothing while the setting is off", () => {
      render(<ArtifactPreview artifact={scripted()} />)
      expect(screen.queryByTestId("artifact-interactive-bar")).toBeNull()
    })

    it("offers nothing for a document with no scripts, even with the setting on", () => {
      mockSettings.artifacts = { interactiveHtml: true }
      render(<ArtifactPreview artifact={dummy({ type: "html", content: "<p>report</p>" })} />)
      expect(screen.queryByTestId("artifact-interactive-bar")).toBeNull()
    })

    it("explains the scripts are inert and keeps the sanitised render until asked", () => {
      mockSettings.artifacts = { interactiveHtml: true }
      const { container } = render(<ArtifactPreview artifact={scripted()} />)
      expect(screen.getByTestId("artifact-interactive-bar")).toHaveTextContent(
        "interactiveOfferHint"
      )
      expect(screen.getByTestId("artifact-interactive-run")).toBeInTheDocument()
      // Still the static frame: same-origin, written in through contentDocument.
      expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-same-origin")
    })

    it("authorises one artifact only, and drops same-origin when it does", async () => {
      mockSettings.artifacts = { interactiveHtml: true }
      const { container } = render(<ArtifactPreview artifact={scripted()} />)
      fireEvent.click(screen.getByTestId("artifact-interactive-run"))
      await waitFor(() =>
        expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts")
      )
      // Opaque origin: no host access, no cookies, no storage.
      expect(container.querySelector("iframe")?.getAttribute("sandbox")).not.toContain(
        "allow-same-origin"
      )
      await waitFor(() =>
        expect(container.querySelector("iframe")?.srcdoc).toContain("artifact-shell.js")
      )
      const srcdoc = container.querySelector("iframe")!.srcdoc
      // The handler was rewritten out of the markup; it comes back as a script.
      expect(srcdoc).not.toContain("onclick")
      expect(srcdoc).toContain("data-cognia-handler")
    })

    it("hands the lifted scripts over once the frame's bootstrap is listening", async () => {
      mockSettings.artifacts = { interactiveHtml: true }
      const { container } = render(<ArtifactPreview artifact={scripted()} />)
      fireEvent.click(screen.getByTestId("artifact-interactive-run"))
      const iframe = container.querySelector("iframe") as HTMLIFrameElement
      await waitFor(() => expect(iframe.srcdoc).toContain("artifact-shell.js"))
      const post = jest.fn()
      const frameWindow = iframe.contentWindow as Window
      frameWindow.postMessage = post
      const event = new MessageEvent("message", { data: { type: "artifact-shell-ready" } })
      Object.defineProperty(event, "source", { value: frameWindow })
      window.dispatchEvent(event)
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "run-scripts",
            scripts: expect.arrayContaining([expect.objectContaining({ code: "function go(){}" })]),
          }),
          "*"
        )
      )
    })

    it("says so when a third-party script had to be dropped", async () => {
      mockSettings.artifacts = { interactiveHtml: true }
      render(
        <ArtifactPreview
          artifact={dummy({
            type: "html",
            content: `<html><body><script src="https://cdn.example/a.js"></script></body></html>`,
          })}
        />
      )
      fireEvent.click(screen.getByTestId("artifact-interactive-run"))
      await waitFor(() =>
        expect(screen.getByTestId("artifact-interactive-dropped")).toHaveTextContent(
          "interactiveDroppedScripts"
        )
      )
    })
  })

  it("stops spinning and says so when a scripted frame never announces itself", async () => {
    // The shape a CSP refusal takes: the bundles are served, the frame loads,
    // and nothing inside it ever runs. Without a deadline the panel spins.
    jest.useFakeTimers()
    try {
      render(<ArtifactPreview artifact={dummy({ type: "react", content: "x" })} />)
      await act(async () => {
        await Promise.resolve()
      })
      act(() => {
        jest.advanceTimersByTime(200)
      })
      await act(async () => {
        await Promise.resolve()
      })
      act(() => {
        jest.advanceTimersByTime(9000)
      })
      expect(screen.getByRole("alert")).toHaveTextContent("runtimeInitFailed")
    } finally {
      jest.useRealTimers()
    }
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

  describe("persisting how the preview settled", () => {
    function seedArtifact(overrides: Partial<Artifact> = {}) {
      return useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "code",
        title: "t",
        content: "x",
        ...overrides,
      })
    }

    beforeEach(() => {
      useArtifactStore.setState({ artifacts: {} })
    })

    it("records a settled render so the workspace runtime filter has something to match", async () => {
      const artifact = seedArtifact()
      render(<ArtifactPreview artifact={artifact} />)

      await waitFor(() =>
        expect(useArtifactStore.getState().artifacts[artifact.id]?.metadata?.runtimeHealth).toBe(
          "ready"
        )
      )
      // Settling is not an edit: routing this through updateArtifact would spin
      // the version counter every time the panel opens.
      expect(useArtifactStore.getState().artifacts[artifact.id]?.version).toBe(artifact.version)
    })

    it("never writes the transient loading state", async () => {
      // An iframe artifact starts out loading; only the settled value lands.
      const artifact = seedArtifact({ type: "html", content: "<html></html>" })
      const written: Array<string | undefined> = []
      const unsubscribe = useArtifactStore.subscribe((state) =>
        written.push(state.artifacts[artifact.id]?.metadata?.runtimeHealth)
      )
      render(<ArtifactPreview artifact={artifact} />)

      await waitFor(() =>
        expect(
          useArtifactStore.getState().artifacts[artifact.id]?.metadata?.runtimeHealth
        ).toBeDefined()
      )
      expect(written).not.toContain("loading")
      unsubscribe()
    })

    it("leaves synthetic previews alone", async () => {
      // Canvas documents are projected onto a throwaway Artifact that has no
      // row in the store.
      render(<ArtifactPreview artifact={dummy({ id: "canvas-doc-1" })} />)

      await waitFor(() => expect(screen.getByTestId("artifact-renderer-code")).toBeInTheDocument())
      expect(useArtifactStore.getState().artifacts["canvas-doc-1"]).toBeUndefined()
    })
  })
})
