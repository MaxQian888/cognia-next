const getDocument = jest.fn()
const workerOptions = { workerSrc: "" }

jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument,
  GlobalWorkerOptions: workerOptions,
}))

// The browser builtin build injects this as an esbuild `define`; stand in for it here.
const globalScope = globalThis as { __COGNIA_PDF_WORKER_URL__?: string }
const workerUrl = "/_cognia/builtin-plugins/_shared/pdf.worker.test.mjs"

import { extractPdfPages, fillPdfFields, inspectPdf } from "./pdf-engine"

let fieldValue = "Before"
let pendingValue = "Before"

function installPdfDocument(bytes: Uint8Array) {
  const extracted = bytes[0] === 3
  const doc = {
    numPages: extracted ? 1 : 2,
    annotationStorage: {
      setValue: jest.fn((_id: string, update: { value?: string }) => {
        if (typeof update.value === "string") pendingValue = update.value
      }),
    },
    getPage: jest.fn(async (pageNumber: number) => ({
      getAnnotations: jest.fn(async () =>
        pageNumber === 1 && !extracted
          ? [
              {
                id: "widget-1",
                fieldName: "customer.name",
                fieldValue,
                fieldType: "Tx",
              },
            ]
          : []
      ),
    })),
    getMetadata: jest.fn(async () => ({ info: { Title: "Form" } })),
    saveDocument: jest.fn(async () => {
      fieldValue = pendingValue
      return Uint8Array.from([2])
    }),
    extractPages: jest.fn(async () => Uint8Array.from([3])),
    destroy: jest.fn(async () => undefined),
  }
  return doc
}

beforeEach(() => {
  globalScope.__COGNIA_PDF_WORKER_URL__ = workerUrl
  workerOptions.workerSrc = ""
  fieldValue = "Before"
  pendingValue = "Before"
  getDocument.mockReset()
  getDocument.mockImplementation(({ data }: { data: Uint8Array }) => {
    const doc = installPdfDocument(data)
    return { promise: Promise.resolve(doc) }
  })
})

describe("PDF engine public file seam", () => {
  it("inspects and fills an AcroForm, then verifies the saved logical value", async () => {
    const source = Uint8Array.from([1])
    const before = await inspectPdf(source)

    expect(before).toMatchObject({
      pageCount: 2,
      encrypted: false,
      fields: [expect.objectContaining({ name: "customer.name", kind: "text", value: "Before" })],
    })

    const filled = await fillPdfFields(source, { "customer.name": "After" })
    const reopened = await inspectPdf(filled.bytes)

    expect(filled.verifiedValues).toEqual({ "customer.name": "After" })
    expect(reopened.fields).toEqual([
      expect.objectContaining({ name: "customer.name", value: "After" }),
    ])
  })

  it("extracts an explicit page selection into a reopenable PDF", async () => {
    const extracted = await extractPdfPages([{ bytes: Uint8Array.from([1]), includePages: [2] }])

    await expect(inspectPdf(extracted)).resolves.toMatchObject({ pageCount: 1 })
  })

  it("points pdf.js at the build-injected worker asset", async () => {
    await inspectPdf(Uint8Array.from([1]))

    expect(workerOptions.workerSrc).toBe(workerUrl)
  })

  it("refuses to open a PDF when the worker URL was never injected", async () => {
    delete globalScope.__COGNIA_PDF_WORKER_URL__

    await expect(inspectPdf(Uint8Array.from([1]))).rejects.toThrow("__COGNIA_PDF_WORKER_URL__")
  })

  it("refuses mutation when a signature marker is present", async () => {
    const signed = new TextEncoder().encode("%PDF-1.7\n/Type /Sig /ByteRange [0 1 2 3]\n")

    await expect(fillPdfFields(signed, { "customer.name": "After" })).rejects.toThrow("signed PDF")
    expect(getDocument).not.toHaveBeenCalled()
  })
})
