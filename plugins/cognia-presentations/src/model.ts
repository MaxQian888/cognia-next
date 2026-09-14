export const PRESENTATION_SCHEMA_VERSION = 1 as const
export const PRESENTATION_ARTIFACT_KIND = "cognia-presentations/deck"
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

export type SlideElement =
  | {
      id: string
      type: "text"
      x: number
      y: number
      width: number
      height: number
      text: string
      fontSize?: number
      bold?: boolean
      color?: string
    }
  | {
      id: string
      type: "shape"
      x: number
      y: number
      width: number
      height: number
      shape?: "rect" | "roundRect" | "ellipse"
      fill?: string
      line?: string
      text?: string
    }
  | {
      id: string
      type: "image"
      x: number
      y: number
      width: number
      height: number
      dataBase64: string
      mimeType: "image/png" | "image/jpeg"
      alt: string
    }
  | {
      id: string
      type: "table"
      x: number
      y: number
      width: number
      height: number
      rows: string[][]
    }
  | {
      id: string
      type: "chart"
      x: number
      y: number
      width: number
      height: number
      labels: string[]
      values: number[]
      title?: string
    }

export interface PresentationSlide {
  id: string
  title: string
  elements: SlideElement[]
  speakerNotes?: string
  sourceNote?: string
}
export interface PresentationDeck {
  schemaVersion: typeof PRESENTATION_SCHEMA_VERSION
  title: string
  width: number
  height: number
  theme: { background: string; foreground: string; accent: string; fontFamily: string }
  slides: PresentationSlide[]
  sourceFilename?: string
  importedFeatures: string[]
}
export type PresentationOperation =
  | {
      op: "addSlide"
      title: string
      elements?: SlideElement[]
      speakerNotes?: string
      sourceNote?: string
      index?: number
    }
  | {
      op: "replaceSlide"
      slideId: string
      title?: string
      elements?: SlideElement[]
      speakerNotes?: string
      sourceNote?: string
    }
  | { op: "removeSlide"; slideId: string }
  | { op: "reorderSlide"; slideId: string; index: number }

export function createPresentation(title: string): PresentationDeck {
  if (!title.trim()) throw new Error("Presentation title is required.")
  return {
    schemaVersion: 1,
    title: title.trim(),
    width: 13.333,
    height: 7.5,
    theme: { background: "F8FAFC", foreground: "0F172A", accent: "2563EB", fontFamily: "Aptos" },
    slides: [],
    importedFeatures: [],
  }
}

const SLIDE_ELEMENT_TYPES = new Set(["text", "shape", "image", "table", "chart"])
const SHAPE_KINDS = new Set(["rect", "roundRect", "ellipse"])
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Structural validation for elements supplied through tool operations. The
 * tool `parametersSchema` can only close the outer object shape, so the
 * per-type required fields and finiteness rules are enforced here before an
 * operation is allowed to persist a malformed element into the artifact.
 */
export function assertSlideElements(
  elements: unknown,
  name = "elements"
): asserts elements is SlideElement[] {
  if (!Array.isArray(elements)) throw new Error(`${name} must be an array.`)
  const seen = new Set<string>()
  for (const element of elements) {
    if (!isRecord(element)) throw new Error(`${name} entries must be objects.`)
    const label = typeof element.id === "string" && element.id ? element.id : "(missing id)"
    if (typeof element.id !== "string" || !element.id.trim())
      throw new Error(`${name} entry requires a non-empty string id.`)
    if (seen.has(element.id)) throw new Error(`${name} has a duplicate id: ${element.id}`)
    seen.add(element.id)
    if (typeof element.type !== "string" || !SLIDE_ELEMENT_TYPES.has(element.type))
      throw new Error(`Element ${label} has an unsupported type: ${String(element.type)}`)
    for (const field of ["x", "y", "width", "height"] as const) {
      if (!isFiniteNumber(element[field]))
        throw new Error(`Element ${label} requires a finite number ${field}.`)
    }
    if (element.type === "text") {
      if (typeof element.text !== "string")
        throw new Error(`Text element ${label} requires a string text.`)
      if (element.fontSize !== undefined && !isFiniteNumber(element.fontSize))
        throw new Error(`Text element ${label} requires a finite fontSize.`)
    } else if (element.type === "shape") {
      if (
        element.shape !== undefined &&
        (typeof element.shape !== "string" || !SHAPE_KINDS.has(element.shape))
      )
        throw new Error(`Shape element ${label} has an unsupported shape: ${String(element.shape)}`)
    } else if (element.type === "image") {
      if (typeof element.dataBase64 !== "string" || !element.dataBase64)
        throw new Error(`Image element ${label} requires dataBase64 content.`)
      if (typeof element.mimeType !== "string" || !IMAGE_MIME_TYPES.has(element.mimeType))
        throw new Error(`Image element ${label} requires mimeType image/png or image/jpeg.`)
      if (typeof element.alt !== "string")
        throw new Error(`Image element ${label} requires a string alt.`)
    } else if (element.type === "table") {
      if (
        !Array.isArray(element.rows) ||
        !element.rows.length ||
        element.rows.some(
          (row) =>
            !Array.isArray(row) || !row.length || row.some((cell) => typeof cell !== "string")
        )
      )
        throw new Error(`Table element ${label} requires rows of non-empty string arrays.`)
    } else {
      if (
        !Array.isArray(element.labels) ||
        element.labels.some((l) => typeof l !== "string") ||
        !Array.isArray(element.values) ||
        element.values.some((v) => !isFiniteNumber(v))
      )
        throw new Error(`Chart element ${label} requires string labels and finite values.`)
    }
  }
}

/**
 * Normalize a user/agent-supplied color to a bare 6-digit hex string. The PPTX
 * writer and the preview both emit `#${hex}` / `srgbClr val=` markup — a
 * non-hex value would produce corrupt XML or broken CSS, so unknown input
 * falls back to the supplied default.
 */
export function normalizeHexColor(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim().replace(/^#/, "")
  return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : fallback
}

export function parsePresentation(content: string): PresentationDeck {
  const parsed = JSON.parse(content) as PresentationDeck
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.slides))
    throw new Error("Unsupported Cognia presentation schema.")
  for (const slide of parsed.slides) {
    if (
      !isRecord(slide) ||
      typeof slide.id !== "string" ||
      typeof slide.title !== "string" ||
      !Array.isArray(slide.elements)
    )
      throw new Error("Corrupt Cognia presentation payload: a slide is malformed.")
  }
  const defaults = createPresentation(
    typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : "Presentation"
  )
  if (typeof parsed.title !== "string" || !parsed.title.trim()) parsed.title = defaults.title
  if (!isFiniteNumber(parsed.width) || parsed.width <= 0) parsed.width = defaults.width
  if (!isFiniteNumber(parsed.height) || parsed.height <= 0) parsed.height = defaults.height
  if (!isRecord(parsed.theme)) parsed.theme = defaults.theme
  else parsed.theme = { ...defaults.theme, ...parsed.theme }
  if (!Array.isArray(parsed.importedFeatures)) parsed.importedFeatures = []
  return parsed
}

export function applyPresentationOperations(
  deck: PresentationDeck,
  operations: PresentationOperation[]
): PresentationDeck {
  const next = structuredClone(deck)
  const usedSlideIds = new Set(next.slides.map((slide) => slide.id))
  let sequence = next.slides.length + 1
  const allocateSlideId = () => {
    while (usedSlideIds.has(`s${sequence}`)) sequence += 1
    const id = `s${sequence++}`
    usedSlideIds.add(id)
    return id
  }
  for (const operation of operations) {
    if (operation.op === "addSlide") {
      if (operation.elements !== undefined)
        assertSlideElements(operation.elements, "addSlide elements")
      const slide = {
        id: allocateSlideId(),
        title: requireText(operation.title, "slide title"),
        elements: operation.elements ?? [],
        ...(operation.speakerNotes ? { speakerNotes: operation.speakerNotes } : {}),
        ...(operation.sourceNote ? { sourceNote: operation.sourceNote } : {}),
      }
      next.slides.splice(
        operation.index === undefined
          ? next.slides.length
          : clampIndex(operation.index, next.slides.length),
        0,
        slide
      )
    } else {
      const index = next.slides.findIndex((slide) => slide.id === operation.slideId)
      if (index < 0) throw new Error(`Slide not found: ${operation.slideId}`)
      if (operation.op === "removeSlide") next.slides.splice(index, 1)
      else if (operation.op === "reorderSlide") {
        const [slide] = next.slides.splice(index, 1)
        next.slides.splice(clampIndex(operation.index, next.slides.length), 0, slide)
      } else {
        if (operation.elements !== undefined)
          assertSlideElements(operation.elements, "replaceSlide elements")
        next.slides[index] = {
          ...next.slides[index],
          ...(operation.title !== undefined
            ? { title: requireText(operation.title, "slide title") }
            : {}),
          ...(operation.elements !== undefined ? { elements: operation.elements } : {}),
          ...(operation.speakerNotes !== undefined ? { speakerNotes: operation.speakerNotes } : {}),
          ...(operation.sourceNote !== undefined ? { sourceNote: operation.sourceNote } : {}),
        }
      }
    }
  }
  return next
}

export function validatePresentation(deck: PresentationDeck) {
  const findings: Array<{
    severity: "error" | "warning"
    code: string
    message: string
    slideId?: string
    elementId?: string
  }> = []
  if (!deck.slides.length)
    findings.push({
      severity: "error",
      code: "deck.empty",
      message: "Presentation requires at least one slide.",
    })
  const slideIds = new Set<string>()
  for (const slide of deck.slides) {
    if (slideIds.has(slide.id))
      findings.push({
        severity: "error",
        code: "slide.duplicate",
        message: `Duplicate slide id: ${slide.id}`,
        slideId: slide.id,
      })
    slideIds.add(slide.id)
    if (!slide.elements.length)
      findings.push({
        severity: "warning",
        code: "slide.empty",
        message: `Slide ${slide.title} has no content.`,
        slideId: slide.id,
      })
    const elementIds = new Set<string>()
    for (const element of slide.elements) {
      if (elementIds.has(element.id))
        findings.push({
          severity: "warning",
          code: "element.duplicate",
          message: `Duplicate element id ${element.id} on slide ${slide.title}.`,
          slideId: slide.id,
          elementId: element.id,
        })
      elementIds.add(element.id)
      if (
        !Number.isFinite(element.x) ||
        !Number.isFinite(element.y) ||
        !Number.isFinite(element.width) ||
        !Number.isFinite(element.height)
      )
        findings.push({
          severity: "error",
          code: "element.geometry",
          message: `Element ${element.id} has non-finite geometry.`,
          slideId: slide.id,
          elementId: element.id,
        })
      else if (
        element.x < 0 ||
        element.y < 0 ||
        element.width <= 0 ||
        element.height <= 0 ||
        element.x + element.width > deck.width ||
        element.y + element.height > deck.height
      )
        findings.push({
          severity: "error",
          code: "element.bounds",
          message: `Element ${element.id} is outside the slide.`,
          slideId: slide.id,
          elementId: element.id,
        })
      if (element.type === "text" && (element.fontSize ?? 24) < 14)
        findings.push({
          severity: "warning",
          code: "text.small",
          message: `Text ${element.id} may be too small for presentation viewing.`,
          slideId: slide.id,
          elementId: element.id,
        })
      if (element.type === "image" && !element.alt.trim())
        findings.push({
          severity: "error",
          code: "image.alt",
          message: `Image ${element.id} requires alt text.`,
          slideId: slide.id,
          elementId: element.id,
        })
      if (element.type === "table") {
        const columns = element.rows[0]?.length ?? 0
        if (element.rows.some((row) => row.length !== columns))
          findings.push({
            severity: "warning",
            code: "table.ragged",
            message: `Table ${element.id} has rows with different column counts.`,
            slideId: slide.id,
            elementId: element.id,
          })
      }
      if (element.type === "chart") {
        if (element.labels.length !== element.values.length)
          findings.push({
            severity: "error",
            code: "chart.length",
            message: `Chart ${element.id} labels and values differ in length.`,
            slideId: slide.id,
            elementId: element.id,
          })
        if (!element.values.length)
          findings.push({
            severity: "warning",
            code: "chart.empty",
            message: `Chart ${element.id} has no values.`,
            slideId: slide.id,
            elementId: element.id,
          })
        if (element.values.some((value) => !Number.isFinite(value)))
          findings.push({
            severity: "error",
            code: "chart.values",
            message: `Chart ${element.id} has a non-finite value.`,
            slideId: slide.id,
            elementId: element.id,
          })
      }
    }
  }
  for (const feature of deck.importedFeatures)
    findings.push({
      severity: "warning",
      code: "import.feature",
      message: `Imported feature requires review: ${feature}`,
    })
  return findings
}

function clampIndex(index: number, length: number) {
  if (!Number.isInteger(index) || index < 0 || index > length)
    throw new Error(`Invalid slide index: ${index}`)
  return index
}
function requireText(value: string, name: string) {
  const clean = value.trim()
  if (!clean) throw new Error(`${name} is required.`)
  return clean
}
