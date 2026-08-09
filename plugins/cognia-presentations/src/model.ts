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
export function parsePresentation(content: string): PresentationDeck {
  const parsed = JSON.parse(content) as PresentationDeck
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.slides))
    throw new Error("Unsupported Cognia presentation schema.")
  return parsed
}

export function applyPresentationOperations(
  deck: PresentationDeck,
  operations: PresentationOperation[]
): PresentationDeck {
  const next = structuredClone(deck)
  let sequence = next.slides.length + 1
  for (const operation of operations) {
    if (operation.op === "addSlide") {
      const slide = {
        id: `s${sequence++}`,
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
      } else
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
  for (const slide of deck.slides) {
    if (!slide.elements.length)
      findings.push({
        severity: "warning",
        code: "slide.empty",
        message: `Slide ${slide.title} has no content.`,
        slideId: slide.id,
      })
    for (const element of slide.elements) {
      if (
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
      if (element.type === "chart" && element.labels.length !== element.values.length)
        findings.push({
          severity: "error",
          code: "chart.length",
          message: `Chart ${element.id} labels and values differ in length.`,
          slideId: slide.id,
          elementId: element.id,
        })
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
