/** @jest-environment jsdom */
import { translate } from "./i18n"
import { applyPresentationOperations, createPresentation } from "./model"
import { createPresentationRenderer } from "./preview"

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars)

function deckWithTwoSlides() {
  return applyPresentationOperations(createPresentation("Demo"), [
    {
      op: "addSlide",
      title: "One",
      elements: [{ id: "t1", type: "text", x: 1, y: 1, width: 5, height: 1, text: "Hello" }],
    },
    {
      op: "addSlide",
      title: "Two",
      elements: [{ id: "t2", type: "text", x: 1, y: 1, width: 5, height: 1, text: "World" }],
    },
  ])
}

it("renders slide navigation and an accessible slide canvas", () => {
  const container = document.createElement("div")
  createPresentationRenderer(t).mount(
    { content: JSON.stringify(deckWithTwoSlides()) } as never,
    container
  )
  expect(container.querySelector("nav")).toHaveAccessibleName("Slides")
  expect(container.querySelector('[role="img"]')).toHaveAccessibleName("One")
  expect(container.textContent).toContain("Slide 1 of 2")
  const buttons = container.querySelectorAll("nav button")
  expect(buttons[1].getAttribute("aria-pressed")).toBe("false")
  ;(buttons[1] as HTMLButtonElement).click()
  expect(container.querySelector('[role="img"]')).toHaveAccessibleName("Two")
  expect(container.textContent).toContain("Slide 2 of 2")
})

it("renders an empty state for a deck without slides", () => {
  const container = document.createElement("div")
  createPresentationRenderer(t).mount(
    { content: JSON.stringify(createPresentation("Empty")) } as never,
    container
  )
  expect(container.textContent).toContain("This presentation has no slides yet.")
  expect(container.querySelector("nav")).toBeNull()
})

it("renders shapes, charts, notes, and validation findings", () => {
  const deck = applyPresentationOperations(createPresentation("Deck"), [
    {
      op: "addSlide",
      title: "Content",
      speakerNotes: "Remember the goal.",
      elements: [
        {
          id: "sh1",
          type: "shape",
          x: 1,
          y: 1,
          width: 2,
          height: 1,
          shape: "roundRect",
          fill: "FF0000",
        },
        {
          id: "ch1",
          type: "chart",
          x: 1,
          y: 3,
          width: 6,
          height: 3,
          labels: ["A", "B"],
          values: [5, -2],
        },
      ],
    },
  ])
  const container = document.createElement("div")
  const handle = createPresentationRenderer(t).mount(
    { content: JSON.stringify(deck) } as never,
    container
  )
  const shapes = container.querySelectorAll<HTMLElement>('[role="img"] div')
  expect([...shapes].some((el) => el.style.borderRadius === "12%")).toBe(true)
  const charts = [...container.querySelectorAll('[role="img"]')]
  expect(charts.some((el) => el.getAttribute("aria-label") === "Chart")).toBe(true)
  expect(container.querySelector("aside")).toHaveAccessibleName("Speaker notes")
  expect(container.querySelector('[role="status"]')).toBeNull()
  handle.update?.({ content: JSON.stringify(deck) } as never)
  handle.dispose()
  expect(container.childElementCount).toBe(0)
})
