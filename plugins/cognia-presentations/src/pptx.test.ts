import { applyPresentationOperations, createPresentation } from "./model"
import { exportPptx, importPptx, validatePptxRoundTrip } from "./pptx"

it("exports a native PPTX package and reopens slide text", async () => {
  const deck = applyPresentationOperations(createPresentation("Launch"), [
    {
      op: "addSlide",
      title: "Overview",
      speakerNotes: "Open with the customer outcome.",
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
        {
          id: "c1",
          type: "chart",
          x: 1,
          y: 2,
          width: 8,
          height: 3,
          labels: ["A", "B"],
          values: [10, 20],
        },
      ],
    },
  ])
  const bytes = await exportPptx(deck)
  await expect(validatePptxRoundTrip(bytes)).resolves.toEqual({ valid: true, slideCount: 1 })
  await expect(importPptx(bytes, "launch.pptx")).resolves.toMatchObject({
    title: "launch",
    importedFeatures: expect.arrayContaining(["speaker notes"]),
    slides: [
      expect.objectContaining({
        elements: expect.arrayContaining([expect.objectContaining({ text: "Launch plan" })]),
      }),
    ],
  })
})
