/** @jest-environment jsdom */
import { applyPresentationOperations, createPresentation } from "./model"
import { createPresentationRenderer } from "./preview"

it("renders slide navigation and an accessible slide canvas", () => {
  const deck = applyPresentationOperations(createPresentation("Demo"), [
    {
      op: "addSlide",
      title: "One",
      elements: [{ id: "t1", type: "text", x: 1, y: 1, width: 5, height: 1, text: "Hello" }],
    },
  ])
  const container = document.createElement("div")
  createPresentationRenderer({ slides: "Slides", notes: "Notes", validation: "Validation" }).mount(
    { content: JSON.stringify(deck) } as never,
    container
  )
  expect(container.querySelector("nav")).toHaveAccessibleName("Slides")
  expect(container.querySelector('[role="img"]')).toHaveAccessibleName("One")
})
