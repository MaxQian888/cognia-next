import { applyPresentationOperations, createPresentation, validatePresentation } from "./model"

it("applies slide operations and validates layout and accessibility", () => {
  const deck = applyPresentationOperations(createPresentation("Launch"), [
    {
      op: "addSlide",
      title: "Overview",
      elements: [
        {
          id: "t1",
          type: "text",
          x: 1,
          y: 1,
          width: 8,
          height: 1,
          text: "Launch plan",
          fontSize: 28,
        },
      ],
    },
  ])
  expect(deck.slides).toHaveLength(1)
  expect(validatePresentation(deck)).toEqual([])
})
