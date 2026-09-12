import type { BrowserAnnotationRow } from "@/lib/db/browser-annotations"
import { annotationBatchHeading, formatAnnotationBatch } from "./annotation-queue"

function annotation(id: string): BrowserAnnotationRow {
  return {
    id,
    sessionId: "s1",
    baseUrl: "http://localhost:3000",
    selection: {
      paneId: "browser-pane",
      tagName: "BUTTON",
      selector: `#${id}`,
      domPath: `main > #${id}`,
      id,
      classes: null,
      rect: { x: 0, y: 0, width: 100, height: 40 },
      outerHTML: `<button id="${id}">Save</button>`,
      text: "Save",
      pageUrl: "http://localhost:3000",
      pageTitle: "Home",
    },
    comment: `Comment ${id}`,
    intent: "fix",
    severity: "suggestion",
    status: "pending",
    thread: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

it("formats indexed annotations as one chat message", () => {
  const output = formatAnnotationBatch([annotation("a"), annotation("b")])
  expect(output).toContain("Browser annotation batch (2)")
  expect(output).toContain("Annotation 1 — fix / suggestion")
  expect(output).toContain("Annotation 2 — fix / suggestion")
  expect(output).toContain("Comment b")
})

describe("annotationBatchHeading", () => {
  const row = (over: Partial<BrowserAnnotationRow> = {}): BrowserAnnotationRow =>
    ({
      id: "r",
      sessionId: "s",
      baseUrl: "https://example.test",
      selection: {
        selector: "#a",
        domPath: "div > a",
        tagName: "a",
        id: null,
        classes: null,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        outerHTML: "<a></a>",
        text: "",
      },
      comment: "c",
      intent: "change",
      severity: "suggestion",
      status: "pending",
      thread: [],
      createdAt: 0,
      updatedAt: 0,
      ...over,
    }) as BrowserAnnotationRow

  it("names the browser for page annotations", () => {
    expect(annotationBatchHeading([row()])).toBe("Browser annotation batch")
  })

  it("names the artifact surface for element annotations", () => {
    // Announcing these as a "Browser annotation batch" would send the model
    // looking for a web page that was never involved.
    expect(
      annotationBatchHeading([
        row({ baseUrl: undefined, target: { kind: "artifact", artifactId: "a1" } }),
      ])
    ).toBe("Artifact annotation batch")
  })

  it("stays neutral rather than picking a side for a mixed batch", () => {
    expect(
      annotationBatchHeading([
        row(),
        row({ baseUrl: undefined, target: { kind: "artifact", artifactId: "a1" } }),
      ])
    ).toBe("Review annotation batch")
  })

  it("headlines the formatted batch with it", () => {
    const out = formatAnnotationBatch([
      row({ baseUrl: undefined, target: { kind: "artifact", artifactId: "a1" } }),
    ])
    expect(out.startsWith("# Artifact annotation batch (1)")).toBe(true)
  })
})
