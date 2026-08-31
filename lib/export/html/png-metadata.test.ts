import { embedPngTwinProvenance } from "./png-metadata"

describe("embedPngTwinProvenance", () => {
  it("inserts complete structured provenance before IEND", async () => {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    const iend = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
    const blob = new Blob([new Uint8Array([...signature, ...iend])], { type: "image/png" })
    const result = await embedPngTwinProvenance(blob, [
      { source: "digital-twin", sourceId: "twin-1", disclosure: "ai-generated" },
    ])
    const text = new TextDecoder().decode(await result.arrayBuffer())
    expect(text).toContain("cognia.provenance")
    expect(text).toContain('"sourceId":"twin-1"')
    expect(text).toContain('"disclosure":"ai-generated"')
  })

  it("leaves an ordinary PNG unchanged", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    await expect(embedPngTwinProvenance(blob, undefined)).resolves.toBe(blob)
  })
})
