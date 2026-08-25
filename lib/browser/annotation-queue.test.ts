import type { BrowserAnnotationRow } from "@/lib/db/browser-annotations"
import { formatAnnotationBatch } from "./annotation-queue"

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
