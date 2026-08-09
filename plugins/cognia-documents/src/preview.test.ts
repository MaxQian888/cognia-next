/** @jest-environment jsdom */

import { applyDocumentOperations, createDocument } from "./model"
import { createDocumentRenderer } from "./preview"

it("renders document content and review state", () => {
  const model = applyDocumentOperations(createDocument("Brief", "Hello"), [
    { op: "addComment", blockId: "b1", text: "Review" },
  ])
  const container = document.createElement("div")
  createDocumentRenderer({
    comments: "Comments",
    changes: "Changes",
    validation: "Validation",
  }).mount({ content: JSON.stringify(model) } as never, container)
  expect(container.querySelector("article")).toHaveTextContent("Hello")
  expect(container.querySelector("aside")).toHaveAccessibleName("Comments")
})
