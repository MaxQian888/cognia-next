import { createContentObject } from "./content"

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
