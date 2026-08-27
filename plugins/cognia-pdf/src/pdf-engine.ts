export type PdfFieldValue = string | string[] | boolean

export interface PdfFieldInspection {
  name: string
  kind: "text" | "checkbox" | "radio" | "choice" | "button" | "signature" | "unknown"
  value: PdfFieldValue | null
  readOnly: boolean
  required: boolean
  pageNumbers: number[]
  widgetIds: string[]
  options?: string[]
}

export interface PdfInspection {
  pageCount: number
  encrypted: boolean
  signed: boolean
  fields: PdfFieldInspection[]
  metadata: Record<string, string>
  warnings: string[]
}

interface PdfAnnotation {
  id?: string
  fieldName?: string
  fieldValue?: unknown
  fieldType?: string
  readOnly?: boolean
  required?: boolean
  checkBox?: boolean
  radioButton?: boolean
  pushButton?: boolean
  combo?: boolean
  multiSelect?: boolean
  buttonValue?: string
  exportValue?: string
  options?: Array<{ displayValue?: string; exportValue?: string } | string>
}

interface PdfDocumentLike {
  numPages: number
  annotationStorage: {
    setValue: (id: string, value: Record<string, unknown>) => void
  }
  getPage: (pageNumber: number) => Promise<{
    getAnnotations: (options?: { intent?: string }) => Promise<PdfAnnotation[]>
  }>
  getMetadata: () => Promise<{ info?: Record<string, unknown> }>
  saveDocument: () => Promise<Uint8Array>
  extractPages: (
    entries: Array<{
      document: Uint8Array | null
      includePages?: Array<number | number[]>
    }>
  ) => Promise<Uint8Array>
  destroy: () => Promise<void>
}

declare const __COGNIA_PDF_WORKER_URL__: string | undefined

function resolvePdfWorkerUrl(): string {
  if (typeof __COGNIA_PDF_WORKER_URL__ === "string") return __COGNIA_PDF_WORKER_URL__
  return new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString()
}

async function loadPdf(bytes: Uint8Array, password?: string): Promise<PdfDocumentLike> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  pdfjs.GlobalWorkerOptions.workerSrc = resolvePdfWorkerUrl()
  const task = pdfjs.getDocument({ data: bytes.slice(), ...(password ? { password } : {}) })
  return (await task.promise) as unknown as PdfDocumentLike
}

export async function inspectPdf(bytes: Uint8Array, password?: string): Promise<PdfInspection> {
  const doc = await loadPdf(bytes, password)
  try {
    const fields = new Map<string, PdfFieldInspection>()
    const warnings: string[] = []

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      const annotations = await page.getAnnotations({ intent: "display" })
      for (const annotation of annotations) {
        if (!annotation.fieldName || !annotation.id) continue
        const kind = fieldKind(annotation)
        const current = fields.get(annotation.fieldName)
        if (current && current.kind !== kind) {
          warnings.push(`Field ${annotation.fieldName} has widgets with conflicting types.`)
        }
        const value = normalizeFieldValue(annotation.fieldValue)
        if (current) {
          if (!current.pageNumbers.includes(pageNumber)) current.pageNumbers.push(pageNumber)
          if (!current.widgetIds.includes(annotation.id)) current.widgetIds.push(annotation.id)
          if (current.value === null && value !== null) current.value = value
        } else {
          fields.set(annotation.fieldName, {
            name: annotation.fieldName,
            kind,
            value,
            readOnly: Boolean(annotation.readOnly),
            required: Boolean(annotation.required),
            pageNumbers: [pageNumber],
            widgetIds: [annotation.id],
            ...(annotation.options ? { options: normalizeOptions(annotation.options) } : {}),
          })
        }
      }
    }

    const metadataResult = await doc.getMetadata()
    const metadata = Object.fromEntries(
      Object.entries(metadataResult.info ?? {})
        .filter(([, value]) => typeof value === "string" || typeof value === "number")
        .map(([key, value]) => [key, String(value)])
    )

    return {
      pageCount: doc.numPages,
      encrypted: containsPdfToken(bytes, "/Encrypt"),
      signed: isSignedPdf(bytes),
      fields: [...fields.values()].sort((a, b) => a.name.localeCompare(b.name)),
      metadata,
      warnings,
    }
  } finally {
    await doc.destroy()
  }
}

export async function fillPdfFields(
  bytes: Uint8Array,
  values: Record<string, PdfFieldValue>,
  options: { password?: string } = {}
): Promise<{ bytes: Uint8Array; verifiedValues: Record<string, PdfFieldValue> }> {
  if (isSignedPdf(bytes)) {
    throw new Error(
      "Refusing to mutate a signed PDF. Preserve the signature or create a copy explicitly."
    )
  }
  const doc = await loadPdf(bytes, options.password)
  try {
    const widgets = new Map<string, PdfAnnotation[]>()
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const annotations = await (
        await doc.getPage(pageNumber)
      ).getAnnotations({ intent: "display" })
      for (const annotation of annotations) {
        if (!annotation.fieldName || !annotation.id) continue
        const list = widgets.get(annotation.fieldName) ?? []
        list.push(annotation)
        widgets.set(annotation.fieldName, list)
      }
    }

    const missing = Object.keys(values).filter((name) => !widgets.has(name))
    if (missing.length > 0) throw new Error(`PDF fields not found: ${missing.sort().join(", ")}`)

    for (const [name, value] of Object.entries(values)) {
      const matching = widgets.get(name)!
      if (matching.some((annotation) => annotation.readOnly)) {
        throw new Error(`PDF field is read-only: ${name}`)
      }
      for (const annotation of matching) {
        doc.annotationStorage.setValue(annotation.id!, annotationStorageValue(annotation, value))
      }
    }

    const saved = new Uint8Array(await doc.saveDocument())
    const reopened = await inspectPdf(saved, options.password)
    const verifiedValues: Record<string, PdfFieldValue> = {}
    for (const [name, expected] of Object.entries(values)) {
      const actual = reopened.fields.find((field) => field.name === name)?.value
      if (!fieldValuesEqual(actual, expected)) {
        throw new Error(`PDF field verification failed for ${name}`)
      }
      verifiedValues[name] = expected
    }
    return { bytes: saved, verifiedValues }
  } finally {
    await doc.destroy()
  }
}

export async function extractPdfPages(
  sources: Array<{ bytes: Uint8Array; includePages?: number[] }>
): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error("At least one PDF source is required.")
  const doc = await loadPdf(sources[0].bytes)
  try {
    const entries = sources.map((source, index) => ({
      document: index === 0 ? null : source.bytes,
      ...(source.includePages
        ? {
            includePages: source.includePages.map((page) => {
              if (!Number.isInteger(page) || page < 1) {
                throw new Error(`Invalid PDF page number: ${page}`)
              }
              return page - 1
            }),
          }
        : {}),
    }))
    return new Uint8Array(await doc.extractPages(entries))
  } finally {
    await doc.destroy()
  }
}

export function isSignedPdf(bytes: Uint8Array): boolean {
  return containsPdfToken(bytes, "/Type /Sig") || containsPdfToken(bytes, "/ByteRange")
}

function fieldKind(annotation: PdfAnnotation): PdfFieldInspection["kind"] {
  if (annotation.fieldType === "Sig") return "signature"
  if (annotation.checkBox) return "checkbox"
  if (annotation.radioButton) return "radio"
  if (annotation.combo || annotation.multiSelect || annotation.fieldType === "Ch") return "choice"
  if (annotation.pushButton) return "button"
  if (annotation.fieldType === "Tx" || annotation.fieldType === undefined) return "text"
  return "unknown"
}

function normalizeFieldValue(value: unknown): PdfFieldValue | null {
  if (typeof value === "string" || typeof value === "boolean") return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[]
  }
  return value === null || value === undefined ? null : String(value)
}

function normalizeOptions(options: NonNullable<PdfAnnotation["options"]>): string[] {
  return options.map((option) =>
    typeof option === "string" ? option : String(option.exportValue ?? option.displayValue ?? "")
  )
}

function annotationStorageValue(
  annotation: PdfAnnotation,
  value: PdfFieldValue
): Record<string, unknown> {
  if (annotation.checkBox || annotation.radioButton) {
    const enabled = typeof value === "boolean" ? value : value !== "Off" && value !== "false"
    return {
      value: enabled ? (annotation.buttonValue ?? annotation.exportValue ?? "Yes") : "Off",
    }
  }
  return { value }
}

function fieldValuesEqual(
  actual: PdfFieldValue | null | undefined,
  expected: PdfFieldValue
): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return JSON.stringify(actual) === JSON.stringify(expected)
  }
  return actual === expected
}

function containsPdfToken(bytes: Uint8Array, token: string): boolean {
  const text = new TextDecoder("latin1").decode(bytes)
  return text.includes(token)
}
