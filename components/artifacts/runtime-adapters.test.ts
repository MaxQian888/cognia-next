/**
 * The adapter table is a contract with `lib/artifacts/export/`, not a wish
 * list. `png` and `pdf` were members of `ArtifactExportFormat` that no adapter
 * offered and no code rendered, while ADR-0139's resident routing prompt told
 * the model chart artifacts were "exportable" on every single send.
 *
 * These tests exist so that can't recur silently.
 */
import {
  ARTIFACT_RUNTIME_ADAPTERS,
  getArtifactExportFormats,
  getArtifactRuntimeAdapter,
  getPreferredArtifactExportFormat,
} from "./runtime-adapters"
import { ARTIFACT_TYPES } from "@/lib/artifacts/constants"
import type { ArtifactExportFormat, ArtifactType } from "@/types"

const ALL_FORMATS: ArtifactExportFormat[] = ["raw", "html", "svg", "png", "pdf"]

describe("ARTIFACT_RUNTIME_ADAPTERS", () => {
  it("covers every artifact type exactly once, keyed by itself", () => {
    for (const type of ARTIFACT_TYPES) {
      expect(ARTIFACT_RUNTIME_ADAPTERS[type]?.type).toBe(type)
    }
    expect(Object.keys(ARTIFACT_RUNTIME_ADAPTERS).sort()).toEqual([...ARTIFACT_TYPES].sort())
  })

  it("gives every renderer transport a rendererType, and no other transport one", () => {
    for (const adapter of Object.values(ARTIFACT_RUNTIME_ADAPTERS)) {
      if (adapter.transport === "renderer") expect(adapter.rendererType).toBeDefined()
      else expect(adapter.rendererType).toBeUndefined()
    }
  })

  it("gives every iframe transport a sandbox attribute, and no other transport one", () => {
    for (const adapter of Object.values(ARTIFACT_RUNTIME_ADAPTERS)) {
      if (adapter.transport === "iframe") expect(adapter.sandbox).toBeTruthy()
      else expect(adapter.sandbox).toBeUndefined()
    }
  })

  it("never lets an iframe transport hold both allow-scripts and allow-same-origin", () => {
    // The pair together defeats the sandbox: a frame with both can reach into
    // the parent document.
    for (const adapter of Object.values(ARTIFACT_RUNTIME_ADAPTERS)) {
      const sandbox = adapter.sandbox ?? ""
      expect(sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin")).toBe(false)
    }
  })
})

describe("declared export formats all have a renderer", () => {
  it("offers only formats from the union", () => {
    for (const adapter of Object.values(ARTIFACT_RUNTIME_ADAPTERS)) {
      for (const format of adapter.exportFormats) expect(ALL_FORMATS).toContain(format)
    }
  })

  it("always offers raw, so no artifact is unexportable", () => {
    for (const adapter of Object.values(ARTIFACT_RUNTIME_ADAPTERS)) {
      expect(adapter.exportFormats).toContain("raw")
    }
  })

  it("never offers png for the jupyter transport, which has no raster path", () => {
    expect(ARTIFACT_RUNTIME_ADAPTERS.jupyter.exportFormats).not.toContain("png")
  })

  it("offers png for react, which captures the live frame rather than the source", () => {
    // Re-rendering the SOURCE off-screen would draw nothing, because unexecuted
    // JSX is not markup. The exporter asks the mounted preview for a snapshot
    // of what it drew, so this format is real but needs a preview on screen.
    expect(ARTIFACT_RUNTIME_ADAPTERS.react.exportFormats).toContain("png")
    expect(ARTIFACT_RUNTIME_ADAPTERS.react.exportFormats).toContain("pdf")
  })

  it("offers png for every visual renderer type", () => {
    for (const type of ["chart", "mermaid", "math", "svg"] as ArtifactType[]) {
      expect(ARTIFACT_RUNTIME_ADAPTERS[type].exportFormats).toContain("png")
    }
  })
})

describe("getArtifactExportFormats", () => {
  it("falls back to the adapter's list when metadata declares nothing", () => {
    expect(getArtifactExportFormats({ type: "chart" })).toEqual(
      ARTIFACT_RUNTIME_ADAPTERS.chart.exportFormats
    )
  })

  it("intersects a metadata declaration with the adapter — never widens it", () => {
    expect(
      getArtifactExportFormats({
        type: "code",
        metadata: { exportFormats: ["raw", "png", "svg"] },
      })
    ).toEqual(["raw"])
  })
})

describe("getPreferredArtifactExportFormat", () => {
  it("keeps the source format as the default download for every type", () => {
    // A one-click download must not silently become a rasterisation.
    for (const type of ARTIFACT_TYPES) {
      expect(["raw", "html", "svg"]).toContain(
        getPreferredArtifactExportFormat({ type } as { type: ArtifactType })
      )
    }
  })

  it("prefers the richer source format for html and svg", () => {
    expect(getPreferredArtifactExportFormat({ type: "html" })).toBe("html")
    expect(getPreferredArtifactExportFormat({ type: "svg" })).toBe("svg")
  })
})

describe("getArtifactRuntimeAdapter", () => {
  it("returns the entry for the requested type", () => {
    expect(getArtifactRuntimeAdapter("mermaid").rendererType).toBe("mermaid")
  })
})
