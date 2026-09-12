const getDocument = jest.fn()
const workerOptions = { workerSrc: "" }

jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument,
  GlobalWorkerOptions: workerOptions,
}))

// The browser builtin build injects this as an esbuild `define`; stand in for it here.
const globalScope = globalThis as { __COGNIA_PDF_WORKER_URL__?: string }
const workerUrl = "/_cognia/builtin-plugins/_shared/pdf.worker.test.mjs"

import { extractPdfPages, fillPdfFields, inspectPdf, isSignedPdf } from "./pdf-engine"

interface MockWidget {
  id: string
  fieldName: string
  fieldType?: string
  checkBox?: boolean
  radioButton?: boolean
  pushButton?: boolean
  exportValue?: string
  buttonValue?: string
  fieldValue?: unknown
  readOnly?: boolean
  required?: boolean
  options?: Array<{ displayValue?: string; exportValue?: string } | string>
  page?: number
}

let initialAnnotations: MockWidget[] = []
let savedAnnotations: MockWidget[] | null = null
let signatures: unknown[] | null = null
let jsActions = false
let metadataError: Error | null = null
let corruptSave = false

const TEXT_FIELD: MockWidget = {
  id: "widget-1",
  fieldName: "customer.name",
  fieldType: "Tx",
  fieldValue: "Before",
}

/**
 * Applies pdf.js's real save semantics to the mock: button widgets persist a
 * per-widget boolean in annotationStorage and serialize their on/off appearance
 * state (checkbox → own exportValue / "Off"; radio → shared parent /V).
 */
function applyStoredValues(annotations: MockWidget[], stored: Map<string, unknown>) {
  const selectedRadioByField = new Map<string, string>()
  for (const widget of annotations) {
    if (widget.radioButton && stored.get(widget.id) === true) {
      selectedRadioByField.set(widget.fieldName, widget.buttonValue ?? "")
    }
  }
  return annotations.map((widget) => {
    if (!stored.has(widget.id)) return widget
    const value = stored.get(widget.id)
    if (widget.checkBox) {
      return { ...widget, fieldValue: value ? (widget.exportValue ?? "Yes") : "Off" }
    }
    if (widget.radioButton) {
      return { ...widget, fieldValue: selectedRadioByField.get(widget.fieldName) ?? "Off" }
    }
    return { ...widget, fieldValue: value }
  })
}

function installPdfDocument(bytes: Uint8Array) {
  const annotations = bytes[0] === 9 && savedAnnotations ? savedAnnotations : initialAnnotations
  const stored = new Map<string, unknown>()
  return {
    numPages: bytes[0] === 3 ? 1 : 2,
    annotationStorage: {
      setValue: jest.fn((id: string, update: { value?: unknown }) => {
        stored.set(id, update.value)
      }),
    },
    getPage: jest.fn(async (pageNumber: number) => ({
      getAnnotations: jest.fn(async () =>
        annotations.filter((widget) => (widget.page ?? 1) === pageNumber)
      ),
    })),
    getMetadata: jest.fn(async () => {
      if (metadataError) throw metadataError
      return { info: { Title: "Form" } }
    }),
    getSignatures: jest.fn(async () => signatures),
    hasJSActions: jest.fn(async () => jsActions),
    saveDocument: jest.fn(async () => {
      savedAnnotations = corruptSave ? [...annotations] : applyStoredValues(annotations, stored)
      return Uint8Array.from([9])
    }),
    extractPages: jest.fn(async () => Uint8Array.from([3])),
    destroy: jest.fn(async () => undefined),
  }
}

beforeEach(() => {
  globalScope.__COGNIA_PDF_WORKER_URL__ = workerUrl
  workerOptions.workerSrc = ""
  initialAnnotations = [TEXT_FIELD]
  savedAnnotations = null
  signatures = null
  jsActions = false
  metadataError = null
  corruptSave = false
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
      signed: false,
      hasJavaScript: false,
      fields: [expect.objectContaining({ name: "customer.name", kind: "text", value: "Before" })],
    })

    const filled = await fillPdfFields(source, { "customer.name": "After" })

    expect(filled.verifiedValues).toEqual({ "customer.name": "After" })
    expect(filled.inspection.fields).toEqual([
      expect.objectContaining({ name: "customer.name", value: "After" }),
    ])
  })

  it("checks and unchecks a checkbox with boolean writes", async () => {
    initialAnnotations = [
      {
        id: "cb-1",
        fieldName: "agree",
        fieldType: "Btn",
        checkBox: true,
        exportValue: "Yes",
        fieldValue: "Off",
      },
    ]
    const source = Uint8Array.from([1])

    const inspected = await inspectPdf(source)
    expect(inspected.fields[0]).toMatchObject({
      name: "agree",
      kind: "checkbox",
      value: false,
      exportValues: ["Yes"],
    })

    const checked = await fillPdfFields(source, { agree: true })
    expect(checked.verifiedValues).toEqual({ agree: true })
    expect(checked.inspection.fields[0]).toMatchObject({ value: true })

    const unchecked = await fillPdfFields(checked.bytes, { agree: false })
    expect(unchecked.inspection.fields[0]).toMatchObject({ value: false })
  })

  it("selects one radio option and deselects the rest", async () => {
    initialAnnotations = [
      {
        id: "r-a",
        fieldName: "size",
        fieldType: "Btn",
        radioButton: true,
        buttonValue: "S",
        fieldValue: "Off",
      },
      {
        id: "r-b",
        fieldName: "size",
        fieldType: "Btn",
        radioButton: true,
        buttonValue: "L",
        fieldValue: "Off",
      },
    ]
    const source = Uint8Array.from([1])

    const inspected = await inspectPdf(source)
    expect(inspected.fields[0]).toMatchObject({
      name: "size",
      kind: "radio",
      value: null,
      exportValues: ["L", "S"],
    })

    const filled = await fillPdfFields(source, { size: "L" })
    expect(filled.verifiedValues).toEqual({ size: "L" })
    expect(filled.inspection.fields[0]).toMatchObject({ value: "L" })
  })

  it("rejects an ambiguous boolean fill on a multi-option radio group", async () => {
    initialAnnotations = [
      {
        id: "r-a",
        fieldName: "size",
        fieldType: "Btn",
        radioButton: true,
        buttonValue: "S",
        fieldValue: "Off",
      },
      {
        id: "r-b",
        fieldName: "size",
        fieldType: "Btn",
        radioButton: true,
        buttonValue: "L",
        fieldValue: "Off",
      },
    ]

    await expect(fillPdfFields(Uint8Array.from([1]), { size: true })).rejects.toThrow(
      "radio group size needs the option's export value"
    )
  })

  it("refuses to fill signature and push-button fields", async () => {
    initialAnnotations = [
      { id: "sig-1", fieldName: "signature", fieldType: "Sig" },
      { id: "btn-1", fieldName: "submit", fieldType: "Btn", pushButton: true },
    ]

    await expect(fillPdfFields(Uint8Array.from([1]), { signature: "x" })).rejects.toThrow(
      "signature fields cannot be filled"
    )
    await expect(fillPdfFields(Uint8Array.from([1]), { submit: true })).rejects.toThrow(
      "push-button fields cannot be filled"
    )
  })

  it("reads checkbox groups as the set of checked export names", async () => {
    initialAnnotations = [
      {
        id: "cb-a",
        fieldName: "toppings",
        fieldType: "Btn",
        checkBox: true,
        exportValue: "Cheese",
        fieldValue: "Cheese",
      },
      {
        id: "cb-b",
        fieldName: "toppings",
        fieldType: "Btn",
        checkBox: true,
        exportValue: "Bacon",
        fieldValue: "Off",
      },
    ]
    const source = Uint8Array.from([1])

    const inspected = await inspectPdf(source)
    expect(inspected.fields[0]).toMatchObject({
      name: "toppings",
      kind: "checkbox",
      value: ["Cheese"],
      exportValues: ["Bacon", "Cheese"],
    })

    const filled = await fillPdfFields(source, { toppings: ["Bacon"] })
    expect(filled.inspection.fields[0]).toMatchObject({ value: ["Bacon"] })
  })

  it("extracts an explicit page selection into a reopenable PDF", async () => {
    const extracted = await extractPdfPages([{ bytes: Uint8Array.from([1]), includePages: [2] }])

    await expect(inspectPdf(extracted)).resolves.toMatchObject({ pageCount: 1 })
  })

  it("threads per-source passwords through extractPages entries", async () => {
    const doc = installPdfDocument(Uint8Array.from([1]))
    getDocument.mockImplementationOnce(() => ({ promise: Promise.resolve(doc) }))

    await extractPdfPages([
      { bytes: Uint8Array.from([1]), password: "pw1" },
      { bytes: Uint8Array.from([2]), includePages: [1], password: "pw2" },
    ])

    expect(doc.extractPages).toHaveBeenCalledWith([
      { document: null, password: "pw1" },
      { document: Uint8Array.from([2]), includePages: [0], password: "pw2" },
    ])
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ password: "pw1" }))
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

  it("refuses mutation when the loaded document reports signatures", async () => {
    signatures = [{ signerName: "Test" }]

    await expect(fillPdfFields(Uint8Array.from([1]), { "customer.name": "After" })).rejects.toThrow(
      "signed PDF"
    )
  })

  it("marks inspected PDFs as signed via getSignatures without byte markers", async () => {
    signatures = [{ signerName: "Test" }]

    await expect(inspectPdf(Uint8Array.from([1]))).resolves.toMatchObject({ signed: true })
  })

  it("surfaces embedded JavaScript in the inspection", async () => {
    jsActions = true

    await expect(inspectPdf(Uint8Array.from([1]))).resolves.toMatchObject({
      hasJavaScript: true,
    })
  })

  it("warns on conflicting widget types within one field name", async () => {
    initialAnnotations = [
      { id: "w-1", fieldName: "mixed", fieldType: "Tx", fieldValue: "a" },
      { id: "w-2", fieldName: "mixed", fieldType: "Btn", checkBox: true, exportValue: "Yes" },
    ]

    const inspected = await inspectPdf(Uint8Array.from([1]))
    expect(inspected.warnings).toEqual([expect.stringContaining("conflicting types")])
  })

  it("reports null for fields with no stored value and warns on unreadable metadata", async () => {
    initialAnnotations = [{ id: "w-1", fieldName: "empty", fieldType: "Tx" }]
    metadataError = new Error("no info dict")

    const inspected = await inspectPdf(Uint8Array.from([1]))
    expect(inspected.fields[0]).toMatchObject({ name: "empty", value: null })
    expect(inspected.metadata).toEqual({})
    expect(inspected.warnings).toEqual([expect.stringContaining("metadata")])
  })

  it("normalizes choice options and non-string field values", async () => {
    initialAnnotations = [
      {
        id: "w-1",
        fieldName: "country",
        fieldType: "Ch",
        combo: true,
        fieldValue: "FR",
        options: [{ exportValue: "FR", displayValue: "France" }, "DE"],
      },
      { id: "w-2", fieldName: "count", fieldType: "XX", fieldValue: 42 },
    ]

    const inspected = await inspectPdf(Uint8Array.from([1]))
    expect(inspected.fields).toEqual([
      expect.objectContaining({ name: "count", kind: "unknown", value: "42" }),
      expect.objectContaining({
        name: "country",
        kind: "choice",
        value: "FR",
        options: ["FR", "DE"],
      }),
    ])
  })

  it("rejects read-only fields and array values on radio groups", async () => {
    initialAnnotations = [
      { id: "w-1", fieldName: "locked", fieldType: "Tx", readOnly: true },
      {
        id: "r-1",
        fieldName: "size",
        fieldType: "Btn",
        radioButton: true,
        buttonValue: "S",
        fieldValue: "Off",
      },
    ]

    await expect(fillPdfFields(Uint8Array.from([1]), { locked: "x" })).rejects.toThrow("read-only")
    await expect(fillPdfFields(Uint8Array.from([1]), { size: ["S"] })).rejects.toThrow(
      "single export value"
    )
  })

  it("fails verification when the saved document drops the written value", async () => {
    corruptSave = true

    await expect(fillPdfFields(Uint8Array.from([1]), { "customer.name": "After" })).rejects.toThrow(
      "verification failed"
    )
  })

  it("rejects non-positive page numbers in extract", async () => {
    await expect(
      extractPdfPages([{ bytes: Uint8Array.from([1]), includePages: [0] }])
    ).rejects.toThrow("Invalid PDF page number")
    await expect(extractPdfPages([])).rejects.toThrow("At least one PDF source")
  })

  it("scans signature tokens past partial matches at the byte level", () => {
    // The first '/' starts a non-matching name; the real token follows it.
    const bytes = new TextEncoder().encode("/X /Type /Sig\n")
    expect(isSignedPdf(bytes)).toBe(true)
    // Partial names plus a lone trailing '/' exercise the index-window boundary.
    const miss = new TextEncoder().encode("/Typo /Signature %PDF body /")
    expect(isSignedPdf(miss)).toBe(false)
  })
})
