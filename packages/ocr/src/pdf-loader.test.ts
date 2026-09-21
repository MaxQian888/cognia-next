/**
 * @jest-environment jsdom
 */

const destroyMock = jest.fn(async () => {})
const cleanupMock = jest.fn()
const renderMock = jest.fn(() => ({ promise: Promise.resolve(), cancel: () => {} }))
const getTextContentMock = jest.fn(async () => ({
  items: [{ str: "hello" }, { str: " world" }, {}],
}))
jest.mock("pdfjs-dist", () => ({
  version: "4.0.0",
  GlobalWorkerOptions: {} as { workerSrc?: string },
  getDocument: jest.fn(() => ({
    destroy: destroyMock,
    promise: Promise.resolve({
      numPages: 3,
      destroy: destroyMock,
      getPage: jest.fn(async (n: number) => ({
        pageNumber: n,
        cleanup: cleanupMock,
        getTextContent: getTextContentMock,
        getViewport: ({ scale }: { scale: number }) => ({ width: 120 * scale, height: 80 * scale }),
        render: renderMock,
      })),
    }),
  })),
}))

import { createPdfLoader } from "./pdf-loader"

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({}) as unknown,
    toDataURL: () => "data:image/png;base64,FAKE",
  }
}

describe("createPdfLoader", () => {
  it("loads a document and reports page count", async () => {
    const loader = createPdfLoader({ createCanvas: () => fakeCanvas() })
    const doc = await loader({ bytes: new Uint8Array([1, 2]) })
    expect(doc.numPages).toBe(3)
  })

  it("maps text-content items to {str} (defaulting missing strings)", async () => {
    const loader = createPdfLoader({ createCanvas: () => fakeCanvas() })
    const doc = await loader({ bytes: new Uint8Array() })
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    expect(content.items).toEqual([{ str: "hello" }, { str: " world" }, { str: "" }])
  })

  it("falls back to document.createElement when no canvas factory is injected", async () => {
    const fake = {
      width: 0,
      height: 0,
      getContext: () => ({}) as unknown,
      toDataURL: () => "data:image/png;base64,DOMFAKE",
    }
    const spy = jest
      .spyOn(document, "createElement")
      .mockReturnValue(fake as unknown as HTMLElement)
    try {
      const loader = createPdfLoader()
      const doc = await loader({ bytes: new Uint8Array() })
      const page = await doc.getPage(1)
      const out = await page.renderToDataUrl({ dpi: 72 })
      expect(spy).toHaveBeenCalledWith("canvas")
      expect(out.dataUrl).toBe("data:image/png;base64,DOMFAKE")
      expect(fake.width).toBe(0)
      expect(fake.height).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("rasterizes a page to a PNG data URL at the requested DPI", async () => {
    const created: Array<{ width: number; height: number }> = []
    const loader = createPdfLoader({
      createCanvas: (width, height) => {
        created.push({ width, height })
        return fakeCanvas()
      },
    })
    const doc = await loader({ bytes: new Uint8Array() })
    const page = await doc.getPage(2)
    const out = await page.renderToDataUrl({ dpi: 144 })
    // scale = 144/72 = 2 → 120*2 x 80*2
    expect(created).toEqual([{ width: 240, height: 160 }])
    expect(out).toEqual({ dataUrl: "data:image/png;base64,FAKE", width: 240, height: 160 })
    expect(renderMock).toHaveBeenCalled()
  })
})

it("exposes cleanup hooks for page and document resources", async () => {
  const doc = await createPdfLoader({ createCanvas: () => fakeCanvas() })({
    bytes: new Uint8Array(),
  })
  const page = await doc.getPage(1)
  await page.cleanup?.()
  await doc.destroy?.()
  expect(cleanupMock).toHaveBeenCalled()
  expect(destroyMock).toHaveBeenCalled()
})

it("cancels a running rasterization and releases its canvas", async () => {
  const controller = new AbortController()
  const canvas = fakeCanvas()
  let rejectRender!: (error: Error) => void
  const cancel = jest.fn(() => rejectRender(new DOMException("cancelled", "AbortError")))
  renderMock.mockReturnValueOnce({
    promise: new Promise<void>((_, reject) => {
      rejectRender = reject
    }),
    cancel,
  })
  const doc = await createPdfLoader({ createCanvas: () => canvas })({ bytes: new Uint8Array() })
  const page = await doc.getPage(1)
  const pending = page.renderToDataUrl({ dpi: 144, signal: controller.signal })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(canvas.width).toBe(0)
  expect(canvas.height).toBe(0)
})
