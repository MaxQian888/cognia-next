/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: () => null,
}))
jest.mock("@/components/chat/renderers/math-block", () => ({
  MathBlock: () => null,
}))
jest.mock("@/components/chat/renderers/mermaid-block", () => ({
  MermaidBlock: () => null,
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: () => null,
}))
jest.mock("./chart-renderer", () => ({
  ChartRenderer: () => null,
}))

import { PluginArtifactRendererHost } from "./artifact-renderers"
import type { Artifact } from "@/types"
import type { PluginArtifactRenderer } from "@/lib/artifacts/renderer-registry"

const dummy: Artifact = {
  id: "a1",
  sessionId: "s",
  messageId: "m",
  type: "code",
  title: "t",
  content: "x",
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("PluginArtifactRendererHost", () => {
  it("invokes the renderer.render and reports 'ready'", () => {
    const onState = jest.fn()
    const r: PluginArtifactRenderer = {
      id: "x",
      canRender: () => true,
      render: () => null,
    }
    render(
      <PluginArtifactRendererHost artifact={dummy} renderer={r} onRuntimeStateChange={onState} />
    )
    expect(onState).toHaveBeenCalledWith("ready")
  })

  it("captures errors thrown by renderer.render and surfaces an alert", async () => {
    const onState = jest.fn()
    const r: PluginArtifactRenderer = {
      id: "boom",
      canRender: () => true,
      render: () => {
        throw new Error("kaboom")
      },
    }
    const { container, findByTestId } = render(
      <PluginArtifactRendererHost
        artifact={dummy}
        renderer={r}
        fallback={<div data-testid="fallback" />}
        onRuntimeStateChange={onState}
      />
    )
    expect(onState).toHaveBeenCalledWith("error", "kaboom")
    // setRenderError is queued via queueMicrotask; wait for the fallback to mount.
    await findByTestId("fallback")
    expect(container.textContent).toMatch(/kaboom/)
  })

  it("cleans up the container on unmount", () => {
    const r: PluginArtifactRenderer = {
      id: "x",
      canRender: () => true,
      render: () => null,
    }
    const { unmount, container } = render(
      <PluginArtifactRendererHost artifact={dummy} renderer={r} />
    )
    unmount()
    expect(container.innerHTML).toBe("")
  })
})
