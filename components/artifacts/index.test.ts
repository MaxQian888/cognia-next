/**
 * @jest-environment jsdom
 */

// CodeBlock pulls in shiki (ESM) — mock to keep the barrel importable.
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: () => null,
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: () => null,
}))

import * as Barrel from "./index"

describe("components/artifacts barrel", () => {
  it("re-exports the public surface", () => {
    expect(typeof Barrel.ArtifactPanel).toBe("function")
    expect(typeof Barrel.ArtifactPanelContent).toBe("function")
    expect(typeof Barrel.ArtifactDock).toBe("function")
    expect(typeof Barrel.ArtifactWorkspaceDock).toBe("function")
    expect(typeof Barrel.ArtifactList).toBe("function")
    expect(typeof Barrel.ArtifactCard).toBe("function")
    expect(typeof Barrel.ArtifactPreview).toBe("function")
    expect(typeof Barrel.ArtifactCreateButton).toBe("function")
    expect(typeof Barrel.JupyterRenderer).toBe("function")
    expect(typeof Barrel.PanelVersionHistory).toBe("function")
    expect(typeof Barrel.getArtifactTypeIcon).toBe("function")
    expect(typeof Barrel.resolveArtifactRenderPlan).toBe("function")
    expect(typeof Barrel.ChartRenderer).toBe("function")
    expect(typeof Barrel.MermaidRenderer).toBe("function")
    expect(typeof Barrel.MathRenderer).toBe("function")
    expect(typeof Barrel.CodeRenderer).toBe("function")
    expect(typeof Barrel.MarkdownRenderer).toBe("function")
    expect(typeof Barrel.getArtifactRuntimeAdapter).toBe("function")
    expect(typeof Barrel.getArtifactAuthoringCapabilities).toBe("function")
    expect(typeof Barrel.getArtifactExportFormats).toBe("function")
    expect(typeof Barrel.getPreferredArtifactExportFormat).toBe("function")
    expect(Barrel.ARTIFACT_RUNTIME_ADAPTERS).toBeDefined()
    expect(Barrel.ARTIFACT_TYPE_ICONS).toBeDefined()
  })
})
