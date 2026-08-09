import { base64ToBytes, bytesToBase64, createPdfArtifactDocument, parsePdfArtifact } from "./model"

it("round-trips PDF bytes through the artifact model", () => {
  const bytes = Uint8Array.from([0, 1, 127, 255])
  expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  expect(
    parsePdfArtifact(
      JSON.stringify(
        createPdfArtifactDocument({
          title: "Form",
          bytes,
          inspection: {
            pageCount: 1,
            encrypted: false,
            signed: false,
            fields: [],
            metadata: {},
            warnings: [],
          },
        })
      )
    )
  ).toMatchObject({ title: "Form", dataBase64: expect.any(String) })
})
