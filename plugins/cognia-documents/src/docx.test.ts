import { createDocument, applyDocumentOperations } from "./model"
import { exportDocx, importDocx, validateDocxRoundTrip } from "./docx"

it("exports a native DOCX, reopens it, and imports its text", async () => {
  const model = applyDocumentOperations(createDocument("Brief", "Hello Cognia"), [
    { op: "appendHeading", text: "Details", level: 2 },
    {
      op: "appendTable",
      rows: [
        ["A", "B"],
        ["1", "2"],
      ],
    },
  ])
  const bytes = await exportDocx(model)
  await expect(validateDocxRoundTrip(bytes)).resolves.toMatchObject({
    valid: true,
    text: expect.stringContaining("Hello Cognia"),
  })
  await expect(importDocx(bytes, "brief.docx")).resolves.toMatchObject({
    title: "brief",
    sourceFilename: "brief.docx",
  })
})
