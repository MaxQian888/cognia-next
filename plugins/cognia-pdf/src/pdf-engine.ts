export type PdfFieldValue = string | string[] | boolean

export interface PdfFieldInspection {
  name: string
  kind: "text" | "checkbox" | "radio" | "choice" | "button" | "signature" | "unknown"
  /**
   * Normalized logical value:
   *  - checkbox with a single distinct export value → boolean
   *  - checkbox group (widgets with different export values) → selected export names
   *  - radio → the selected option's export name, or null when nothing is selected
   *  - text/choice → string or string[] verbatim
   */
  value: PdfFieldValue | null
  readOnly: boolean
  required: boolean
  pageNumbers: number[]
  widgetIds: string[]
  /** Distinct on-state export names across the field's widgets (checkbox/radio only). */
  exportValues?: string[]
  options?: string[]
}

export interface PdfInspection {
  pageCount: number
  encrypted: boolean
  signed: boolean
  hasJavaScript?: boolean
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
  getSignatures?: () => Promise<Array<unknown> | null>
  hasJSActions?: () => Promise<boolean>
  saveDocument: () => Promise<Uint8Array>
  extractPages: (
    entries: Array<{
      document: Uint8Array | null
      includePages?: Array<number | number[]>
      password?: string
    }>
  ) => Promise<Uint8Array>
  destroy: () => Promise<void>
}

declare const __COGNIA_PDF_WORKER_URL__: string | undefined

/**
 * The worker asset is emitted under a content hash by
 * `scripts/build/build-browser-builtin-plugins.mjs`, so its URL is only knowable at build
 * time and is injected through the `__COGNIA_PDF_WORKER_URL__` define. There is no
 * derivable fallback: a bundle without the define has no worker to point at.
 */
function resolvePdfWorkerUrl(): string {
  if (typeof __COGNIA_PDF_WORKER_URL__ === "string" && __COGNIA_PDF_WORKER_URL__.length > 0) {
    return __COGNIA_PDF_WORKER_URL__
  }
  throw new Error(
    "cognia-pdf was bundled without __COGNIA_PDF_WORKER_URL__; the pdf.js worker asset is unavailable."
  )
}

async function loadPdf(bytes: Uint8Array, password?: string): Promise<PdfDocumentLike> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  pdfjs.GlobalWorkerOptions.workerSrc = resolvePdfWorkerUrl()
  const task = pdfjs.getDocument({ data: bytes.slice(), ...(password ? { password } : {}) })
  return (await task.promise) as unknown as PdfDocumentLike
}

interface FieldWidgets {
  widgets: PdfAnnotation[]
  pageNumbers: number[]
}

/**
 * Collect the AcroForm widget annotations grouped by field name. Widget ids and the
 * per-widget raw `fieldValue`/`exportValue`/`buttonValue` are what the fill path and
 * the value normalization both need, so inspection and fill share this one walk.
 */
async function collectFieldWidgets(
  doc: PdfDocumentLike
): Promise<{ byField: Map<string, FieldWidgets>; warnings: string[] }> {
  const byField = new Map<string, FieldWidgets>()
  const warnings: string[] = []
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const annotations = await page.getAnnotations({ intent: "display" })
    for (const annotation of annotations) {
      if (!annotation.fieldName || !annotation.id) continue
      const entry = byField.get(annotation.fieldName) ?? { widgets: [], pageNumbers: [] }
      const existing = entry.widgets[0]
      if (existing && fieldKind(existing) !== fieldKind(annotation)) {
        warnings.push(`Field ${annotation.fieldName} has widgets with conflicting types.`)
      }
      entry.widgets.push(annotation)
      if (!entry.pageNumbers.includes(pageNumber)) entry.pageNumbers.push(pageNumber)
      byField.set(annotation.fieldName, entry)
    }
  }
  return { byField, warnings }
}

/** Widget on-state name: checkboxes export `exportValue`, radios `buttonValue`. */
function widgetOnValue(annotation: PdfAnnotation): string {
  if (annotation.checkBox) return annotation.exportValue ?? "Yes"
  return annotation.buttonValue ?? ""
}

/**
 * Reduce a field's widget annotations to one logical value. pdf.js reports checkbox
 * `fieldValue` per widget (its own appearance state) and radio `fieldValue` as the
 * shared parent /V, so the raw annotations can't be surfaced verbatim.
 */
function inspectedFieldValue(
  kind: PdfFieldInspection["kind"],
  widgets: PdfAnnotation[]
): PdfFieldValue | null {
  if (kind === "checkbox") {
    const exportValues = [...new Set(widgets.map(widgetOnValue))]
    if (exportValues.length <= 1) {
      const onValue = exportValues[0] ?? "Yes"
      return widgets.some((widget) => normalizeFieldValue(widget.fieldValue) === onValue)
    }
    return exportValues
      .filter((exportValue) =>
        widgets.some(
          (widget) =>
            widgetOnValue(widget) === exportValue &&
            normalizeFieldValue(widget.fieldValue) === exportValue
        )
      )
      .sort()
  }
  if (kind === "radio") {
    for (const widget of widgets) {
      const value = normalizeFieldValue(widget.fieldValue)
      if (value === null || value === "Off") continue
      return value
    }
    return null
  }
  for (const widget of widgets) {
    const value = normalizeFieldValue(widget.fieldValue)
    if (value !== null) return value
  }
  return null
}

export async function inspectPdf(bytes: Uint8Array, password?: string): Promise<PdfInspection> {
  const doc = await loadPdf(bytes, password)
  try {
    const { byField, warnings } = await collectFieldWidgets(doc)
    const fields: PdfFieldInspection[] = []
    for (const [name, entry] of byField) {
      const widgets = entry.widgets
      const kind = fieldKind(widgets[0])
      const exportValues =
        kind === "checkbox" || kind === "radio"
          ? [...new Set(widgets.map(widgetOnValue).filter((value) => value.length > 0))].sort()
          : undefined
      fields.push({
        name,
        kind,
        value: inspectedFieldValue(kind, widgets),
        readOnly: widgets.some((widget) => Boolean(widget.readOnly)),
        required: widgets.some((widget) => Boolean(widget.required)),
        pageNumbers: entry.pageNumbers,
        widgetIds: widgets.map((widget) => widget.id!),
        ...(exportValues && exportValues.length > 0 ? { exportValues } : {}),
        ...(widgets[0].options ? { options: normalizeOptions(widgets[0].options) } : {}),
      })
    }

    let metadata: Record<string, string> = {}
    try {
      const metadataResult = await doc.getMetadata()
      metadata = Object.fromEntries(
        Object.entries(metadataResult.info ?? {})
          .filter(([, value]) => typeof value === "string" || typeof value === "number")
          .map(([key, value]) => [key, String(value)])
      )
    } catch (error) {
      warnings.push(
        `PDF metadata could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const signatures = doc.getSignatures ? await doc.getSignatures() : null

    return {
      pageCount: doc.numPages,
      encrypted: containsPdfToken(bytes, "/Encrypt"),
      // `getSignatures` is authoritative (it survives object-stream compression that
      // hides the /ByteRange marker from the byte scan); the scan is the fallback for
      // pdf.js builds that predate the API.
      signed: signatures ? signatures.length > 0 : isSignedPdf(bytes),
      hasJavaScript: Boolean(await doc.hasJSActions?.()),
      fields: fields.sort((a, b) => a.name.localeCompare(b.name)),
      metadata,
      warnings,
    }
  } finally {
    await doc.destroy()
  }
}

/**
 * Canonical "selected export-name set" for a button field. All button comparisons —
 * post-fill verification and artifact validation — go through this so `true`,
 * `"Yes"`, and `["Yes"]` mean the same thing on a single checkbox.
 */
function buttonSelection(
  field: Pick<PdfFieldInspection, "kind" | "exportValues">,
  value: PdfFieldValue | null | undefined
): Set<string> {
  if (value === false || value === null || value === undefined || value === "Off") {
    return new Set()
  }
  if (value === true) return new Set(field.exportValues ?? ["Yes"])
  if (typeof value === "string") return new Set([value])
  return new Set(value.filter((entry) => entry !== "Off"))
}

/** Whether a stored/inspected field value matches a caller-supplied expectation. */
export function pdfFieldValueMatches(
  field: Pick<PdfFieldInspection, "kind" | "exportValues" | "value">,
  expected: PdfFieldValue
): boolean {
  if (field.kind === "checkbox" || field.kind === "radio") {
    const expectedSet = buttonSelection(field, expected)
    const actualSet = buttonSelection(field, field.value)
    if (expectedSet.size !== actualSet.size) return false
    for (const entry of expectedSet) if (!actualSet.has(entry)) return false
    return true
  }
  return JSON.stringify(field.value ?? null) === JSON.stringify(expected)
}

export async function fillPdfFields(
  bytes: Uint8Array,
  values: Record<string, PdfFieldValue>,
  options: { password?: string } = {}
): Promise<{
  bytes: Uint8Array
  verifiedValues: Record<string, PdfFieldValue>
  inspection: PdfInspection
}> {
  // Fast path: a plaintext /ByteRange marker refuses the mutation before paying for
  // a document load. Compressed signature dictionaries still get caught by
  // doc.getSignatures() below.
  if (isSignedPdf(bytes)) {
    throw new Error(
      "Refusing to mutate a signed PDF. Preserve the signature or create a copy explicitly."
    )
  }
  const doc = await loadPdf(bytes, options.password)
  try {
    const signatures = doc.getSignatures ? await doc.getSignatures() : null
    if (signatures && signatures.length > 0) {
      throw new Error(
        "Refusing to mutate a signed PDF. Preserve the signature or create a copy explicitly."
      )
    }

    const { byField } = await collectFieldWidgets(doc)

    const missing = Object.keys(values).filter((name) => !byField.has(name))
    if (missing.length > 0) throw new Error(`PDF fields not found: ${missing.sort().join(", ")}`)

    for (const [name, value] of Object.entries(values)) {
      const matching = byField.get(name)!.widgets
      const kind = fieldKind(matching[0])
      if (kind === "signature") {
        throw new Error(`PDF signature fields cannot be filled: ${name}`)
      }
      if (kind === "button") {
        throw new Error(`PDF push-button fields cannot be filled: ${name}`)
      }
      if (matching.some((annotation) => annotation.readOnly)) {
        throw new Error(`PDF field is read-only: ${name}`)
      }

      if (kind === "checkbox" || kind === "radio") {
        // pdf.js serializes button widgets from a per-widget boolean in
        // annotationStorage (`{value: checked}`) — never the export-name string.
        const exportValues = matching.map(widgetOnValue)
        const distinct = new Set(exportValues)
        if (kind === "radio" && value === true && distinct.size > 1) {
          throw new Error(
            `PDF radio group ${name} needs the option's export value, not true. ` +
              `Options: ${[...distinct].sort().join(", ")}`
          )
        }
        if (kind === "radio" && Array.isArray(value)) {
          throw new Error(`PDF radio group ${name} accepts a single export value.`)
        }
        const selected = buttonSelection({ kind, exportValues: [...distinct] }, value)
        for (const annotation of matching) {
          doc.annotationStorage.setValue(annotation.id!, {
            value: selected.has(widgetOnValue(annotation)),
          })
        }
      } else {
        for (const annotation of matching) {
          doc.annotationStorage.setValue(annotation.id!, { value })
        }
      }
    }

    const saved = new Uint8Array(await doc.saveDocument())
    const reopened = await inspectPdf(saved, options.password)
    const verifiedValues: Record<string, PdfFieldValue> = {}
    for (const [name, expected] of Object.entries(values)) {
      const field = reopened.fields.find((entry) => entry.name === name)
      if (!field || !pdfFieldValueMatches(field, expected)) {
        throw new Error(`PDF field verification failed for ${name}`)
      }
      verifiedValues[name] = expected
    }
    return { bytes: saved, verifiedValues, inspection: reopened }
  } finally {
    await doc.destroy()
  }
}

export async function extractPdfPages(
  sources: Array<{ bytes: Uint8Array; includePages?: number[]; password?: string }>
): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error("At least one PDF source is required.")
  const doc = await loadPdf(sources[0].bytes, sources[0].password)
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
      ...(source.password ? { password: source.password } : {}),
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

/**
 * Byte-level substring search — no latin1 decode of the whole file (a 50MB PDF used
 * to allocate a 50MB string per token, several times per operation).
 */
function containsPdfToken(bytes: Uint8Array, token: string): boolean {
  const needle = new TextEncoder().encode(token)
  if (needle.length === 0 || bytes.length < needle.length) return false
  let index = bytes.indexOf(needle[0])
  while (index !== -1 && index <= bytes.length - needle.length) {
    let matched = true
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
    index = bytes.indexOf(needle[0], index + 1)
  }
  return false
}
