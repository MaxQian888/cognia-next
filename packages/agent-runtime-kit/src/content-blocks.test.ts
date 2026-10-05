import { contentBlocksText, externalContentFromBlock } from "./content-blocks"

it("retains image and resource bytes in results without exposing them in text projections", () => {
  expect(externalContentFromBlock({ type: "image", data: "AAEC", mimeType: "image/png" })).toEqual({
    type: "image",
    source: { type: "base64", data: "AAEC", mediaType: "image/png" },
  })
  const resource = {
    type: "resource" as const,
    resource: { uri: "a2a:report.bin", mimeType: "application/octet-stream", blob: "AAEC" },
  }
  expect(externalContentFromBlock(resource)).toEqual(resource)
  expect(contentBlocksText([{ type: "text", text: "Report: " }, resource])).toBe(
    "Report: [file: a2a:report.bin]"
  )
})
