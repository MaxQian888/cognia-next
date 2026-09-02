/** @jest-environment node */
import { ProviderOperationFailureError } from "../failure"
import {
  blobOf,
  bytesOf,
  bytesRefOf,
  bytesRefOfGenerated,
  dataContentOf,
  mimeTypeOf,
} from "./bytes"

describe("bytesRef conversions", () => {
  it("decodes base64 and data URLs to bytes and refuses a url-only ref", () => {
    expect([...bytesOf({ base64: "aGk=" })]).toEqual([104, 105])
    expect([...bytesOf({ dataUrl: "data:text/plain;base64,aGk=" })]).toEqual([104, 105])
    expect(() => bytesOf({ url: "https://x/y" })).toThrow(ProviderOperationFailureError)
    expect(() => bytesOf({ dataUrl: "data:text/plain,hi" })).toThrow(/base64 data URLs/)
  })

  it("passes the SDK the cheapest representation it accepts", () => {
    const bytes = new Uint8Array([1])
    expect(dataContentOf({ bytes })).toBe(bytes)
    expect(dataContentOf({ dataUrl: "data:a/b;base64,AQ==" })).toBe("data:a/b;base64,AQ==")
    expect(dataContentOf({ url: "https://x/y" })).toBe("https://x/y")
    expect(() => dataContentOf({})).toThrow(/empty/)
  })

  it("derives the mime type from the ref or the data URL", () => {
    expect(mimeTypeOf({ mimeType: "audio/wav" })).toBe("audio/wav")
    expect(mimeTypeOf({ dataUrl: "data:image/png;base64,AQ==" })).toBe("image/png")
    expect(mimeTypeOf({ base64: "AQ==" })).toBe("application/octet-stream")
  })

  it("builds a blob for uploads and a serialisable ref for downloads", async () => {
    const blob = blobOf({ base64: "aGk=", mimeType: "text/plain" })
    expect(blob.type).toBe("text/plain")
    expect(await blob.text()).toBe("hi")
    const ref = bytesRefOf(new Uint8Array([104, 105]), "text/plain")
    expect(ref.base64).toBe("aGk=")
    expect(ref.mimeType).toBe("text/plain")
    expect(bytesRefOfGenerated({ base64: "AQ==", mediaType: "image/png" })).toEqual({
      base64: "AQ==",
      mimeType: "image/png",
    })
  })
})
