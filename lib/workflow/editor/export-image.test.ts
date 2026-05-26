/**
 * @jest-environment jsdom
 */

import type { Node } from "@xyflow/react"
import { exportWorkflowImage, renderWorkflowImageBlob } from "./export-image"

const mockHtml2canvas = jest.fn()
jest.mock("html2canvas", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockHtml2canvas(...args),
}))

jest.mock("@xyflow/react", () => ({
  __esModule: true,
  getNodesBounds: jest.fn(() => ({ x: 0, y: 0, width: 2000, height: 1000 })),
  getViewportForBounds: jest.fn(() => ({ x: 10, y: 20, zoom: 1.5 })),
}))

const nodes = [{ id: "n1", position: { x: 0, y: 0 }, data: {} }] as unknown as Node[]

function makeFlowEl(withViewport: boolean): HTMLElement {
  const wrapper = document.createElement("div")
  if (withViewport) {
    const vp = document.createElement("div")
    vp.className = "react-flow__viewport"
    wrapper.appendChild(vp)
  }
  document.body.appendChild(wrapper)
  return wrapper
}

beforeEach(() => {
  jest.clearAllMocks()
  document.body.innerHTML = ""
  mockHtml2canvas.mockResolvedValue({
    toDataURL: () => "data:image/png;base64,AAAA",
  })
})

describe("exportWorkflowImage", () => {
  it("throws when there are no nodes", async () => {
    const flowEl = makeFlowEl(true)
    await expect(exportWorkflowImage({ flowEl, nodes: [], fileName: "wf" })).rejects.toThrow(
      /no nodes/i
    )
  })

  it("throws when the viewport element is missing", async () => {
    const flowEl = makeFlowEl(false)
    await expect(exportWorkflowImage({ flowEl, nodes, fileName: "wf" })).rejects.toThrow(
      /viewport/i
    )
  })

  it("rasterises the viewport and triggers a .png download", async () => {
    const flowEl = makeFlowEl(true)
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    await exportWorkflowImage({ flowEl, nodes, fileName: "My Flow" })

    expect(mockHtml2canvas).toHaveBeenCalledTimes(1)
    const [el, opts] = mockHtml2canvas.mock.calls[0] as [HTMLElement, Record<string, unknown>]
    expect(el.className).toBe("react-flow__viewport")
    expect(opts.width).toBe(2480) // 2000 * 1.24
    expect(opts.height).toBe(1240) // 1000 * 1.24
    expect(clickSpy).toHaveBeenCalledTimes(1)
    clickSpy.mockRestore()
  })

  it("appends .png only when missing and applies the fit transform via onclone", async () => {
    const flowEl = makeFlowEl(true)
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    let captured: HTMLAnchorElement | null = null
    const origCreate = document.createElement.bind(document)
    jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === "a") captured = el as HTMLAnchorElement
      return el
    })

    // Drive the onclone hook so the transform branch is exercised.
    mockHtml2canvas.mockImplementation(async (_el: HTMLElement, opts: Record<string, unknown>) => {
      ;(opts.onclone as (doc: Document) => void)(document)
      return { toDataURL: () => "data:image/png;base64,AAAA" }
    })

    await exportWorkflowImage({ flowEl, nodes, fileName: "already.png" })

    const vp = flowEl.querySelector<HTMLElement>(".react-flow__viewport")!
    expect(vp.style.transform).toBe("translate(10px, 20px) scale(1.5)")
    expect(captured!.download).toBe("already.png")
    ;(document.createElement as jest.Mock).mockRestore()
  })
})

describe("renderWorkflowImageBlob", () => {
  it("resolves a PNG blob from the rasterised canvas", async () => {
    const flowEl = makeFlowEl(true)
    mockHtml2canvas.mockResolvedValue({
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["x"], { type: "image/png" })),
    })
    const blob = await renderWorkflowImageBlob({ flowEl, nodes, backgroundColor: null })
    expect(blob.type).toBe("image/png")
  })

  it("rejects when the canvas yields no blob", async () => {
    const flowEl = makeFlowEl(true)
    mockHtml2canvas.mockResolvedValue({ toBlob: (cb: (b: Blob | null) => void) => cb(null) })
    await expect(renderWorkflowImageBlob({ flowEl, nodes })).rejects.toThrow(/rasterise/i)
  })
})
