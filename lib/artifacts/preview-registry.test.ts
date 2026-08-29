/** @jest-environment jsdom */
import {
  clearArtifactPreviewNodes,
  getArtifactPreviewNode,
  registerArtifactPreviewNode,
} from "./preview-registry"

afterEach(() => {
  clearArtifactPreviewNodes()
  document.body.innerHTML = ""
})

function mount(): HTMLElement {
  const el = document.createElement("div")
  document.body.appendChild(el)
  return el
}

describe("artifact preview registry", () => {
  it("returns null for an unknown artifact", () => {
    expect(getArtifactPreviewNode("nope")).toBeNull()
  })

  it("hands back the node that is painting the artifact", () => {
    const el = mount()
    registerArtifactPreviewNode("a1", el)
    expect(getArtifactPreviewNode("a1")).toBe(el)
  })

  it("drops a node that has been detached from the document", () => {
    // A stale entry would rasterise to a blank image — worse than a typed
    // failure the caller can explain.
    const el = mount()
    registerArtifactPreviewNode("a1", el)
    el.remove()
    expect(getArtifactPreviewNode("a1")).toBeNull()
    // …and the entry is gone, not merely filtered.
    document.body.appendChild(el)
    expect(getArtifactPreviewNode("a1")).toBeNull()
  })

  it("replaces the entry when the same artifact remounts", () => {
    const first = mount()
    registerArtifactPreviewNode("a1", first)
    const second = mount()
    registerArtifactPreviewNode("a1", second)
    expect(getArtifactPreviewNode("a1")).toBe(second)
  })

  it("a stale disposer does not evict the live registration", () => {
    const first = mount()
    const disposeFirst = registerArtifactPreviewNode("a1", first)
    const second = mount()
    registerArtifactPreviewNode("a1", second)
    disposeFirst()
    expect(getArtifactPreviewNode("a1")).toBe(second)
  })

  it("the disposer removes its own registration", () => {
    const el = mount()
    registerArtifactPreviewNode("a1", el)()
    expect(getArtifactPreviewNode("a1")).toBeNull()
  })
})
