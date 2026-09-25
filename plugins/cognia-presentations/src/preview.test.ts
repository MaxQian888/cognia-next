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

const noLocale = () => () => {}

it("renders slide navigation and a slide canvas whose text stays accessible", () => {
  const container = document.createElement("div")
  createPresentationRenderer(t, noLocale).mount(
    { content: JSON.stringify(deckWithTwoSlides()) } as never,
    container
  )
  expect(container.querySelector("nav")).toHaveAccessibleName("Slides")
  const canvas = container.querySelector(".cpres-canvas")!
  // A labelled group, not role="img" — the slide's text is not hidden.
  expect(canvas).toHaveAttribute("role", "group")
  expect(canvas).toHaveAttribute("aria-roledescription", "slide")
  expect(canvas).toHaveAccessibleName("Slide 1: One")
  expect(canvas).toHaveTextContent("Hello")
  expect(container.textContent).toContain("Slide 1 of 2")
  const buttons = container.querySelectorAll("nav button")
  expect(buttons[1].getAttribute("aria-pressed")).toBe("false")
  ;(buttons[1] as HTMLButtonElement).click()
  expect(container.querySelector(".cpres-canvas")).toHaveAccessibleName("Slide 2: Two")
  expect(container.textContent).toContain("Slide 2 of 2")
})

it("keeps keyboard focus across re-renders and pages with the arrow keys", () => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  let onLocale: () => void = () => {}
  const handle = createPresentationRenderer(t, (handler) => {
    onLocale = handler
    return () => {}
  }).mount({ content: JSON.stringify(deckWithTwoSlides()) } as never, container)
  const thumb = () => container.querySelectorAll<HTMLButtonElement>("nav button")[1]
  thumb().focus()
  thumb().click()
  expect(document.activeElement).toBe(thumb())
  onLocale()
  expect(document.activeElement).toBe(thumb())
  handle.update?.({ content: JSON.stringify(deckWithTwoSlides()) } as never)
  expect(document.activeElement).toBe(thumb())

  const canvas = () => container.querySelector<HTMLElement>(".cpres-canvas")!
  canvas().focus()
  canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
  expect(container.textContent).toContain("Slide 1 of 2")
  expect(document.activeElement).toBe(canvas())
  canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
  expect(container.textContent).toContain("Slide 2 of 2")
  const css = container.querySelector("style")?.textContent ?? ""
  expect(css).toContain("@media (pointer:coarse) { .cpres-thumb { min-height:36px;")
  expect(css).toContain(":focus-visible")
  expect(css).toContain("prefers-reduced-motion")
  document.body.replaceChildren()
})

it("shows a localized error for an unreadable deck instead of throwing", () => {
  const container = document.createElement("div")
  expect(() =>
    createPresentationRenderer(t, noLocale).mount({ content: "{nope" } as never, container)
  ).not.toThrow()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "This artifact is not a valid Cognia presentation"
  )
})

it("renders an empty state for a deck without slides", () => {
  const container = document.createElement("div")
  createPresentationRenderer(t, noLocale).mount(
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
  const handle = createPresentationRenderer(t, noLocale).mount(
    { content: JSON.stringify(deck) } as never,
    container
  )
  const shapes = container.querySelectorAll<HTMLElement>(".cpres-canvas div")
  expect([...shapes].some((el) => el.style.borderRadius === "12%")).toBe(true)
  const charts = [...container.querySelectorAll('[role="img"]')]
  expect(charts.some((el) => el.getAttribute("aria-label") === "Chart")).toBe(true)
  expect(container.querySelector("aside")).toHaveAccessibleName("Speaker notes")
  expect(container.querySelector('[role="status"]')).toBeNull()
  handle.update?.({ content: JSON.stringify(deck) } as never)
  handle.dispose()
  expect(container.childElementCount).toBe(0)
})
