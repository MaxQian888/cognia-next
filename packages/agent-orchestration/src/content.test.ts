import { createContentObject, verifiedContent } from "./content"

describe("createContentObject", () => {
  it("addresses content by its SHA-256 and keeps the bytes", async () => {
    const object = await createContentObject("abc", "text/plain", 5)
    expect(object).toMatchObject({ mimeType: "text/plain", byteLength: 3, createdAt: 5 })
    expect(object.hash).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
    expect(await createContentObject(new TextEncoder().encode("abc"), "x", 1)).toMatchObject({
      hash: object.hash,
    })
  })
})

describe("verifiedContent", () => {
  it("returns an intact object and refuses missing, truncated or corrupted bytes", async () => {
    const object = await createContentObject("result", "text/plain", 1)
    expect(await verifiedContent(object, object.hash)).toBe(object)
    expect(await verifiedContent(undefined, object.hash)).toBeUndefined()
    expect(
      await verifiedContent({ ...object, data: object.data.slice(0, 3) }, object.hash)
    ).toBeUndefined()
    expect(
      await verifiedContent({ ...object, data: new TextEncoder().encode("forged") }, object.hash)
    ).toBeUndefined()
  })
})
