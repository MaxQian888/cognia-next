import { saveImageEditVersion } from "./save"
import { readImageEditVersion, IMAGE_EDIT_SCHEMA_VERSION } from "./version"

const ingested = {
  ref: "cognia-media:edited",
  mediaType: "image/webp",
  width: 8,
  height: 4,
  byteSize: 64,
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    ingest: jest.fn(async () => ingested),
    append: jest.fn(async () => ({ appended: true, parts: [] })),
    ...overrides,
  } as never
}

const base = {
  sessionId: "s1",
  messageId: "m1",
  lineageId: "cognia-media:origin",
  parentVersionId: null,
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: "image/webp",
  operations: ["crop" as const],
  now: () => 1700,
}

describe("saveImageEditVersion", () => {
  it("ingests the bytes then appends a version referencing them", async () => {
    const d = deps()
    const result = await saveImageEditVersion({ ...base, versionId: "iev_x" }, d)

    expect(d.ingest).toHaveBeenCalledWith({
      bytes: base.bytes,
      mediaType: "image/webp",
      keepOriginal: false,
    })
    expect(d.append).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m1",
      media: ingested,
      version: {
        schemaVersion: IMAGE_EDIT_SCHEMA_VERSION,
        lineageId: "cognia-media:origin",
        versionId: "iev_x",
        parentVersionId: null,
        operations: ["crop"],
        editedAt: 1700,
      },
    })
    expect(result).toMatchObject({ appended: true, ref: "cognia-media:edited" })
  })

  it("does not keep a second copy of the derived bytes", async () => {
    // The untouched original is already its own part on the same message.
    const d = deps()
    await saveImageEditVersion(base, d)
    expect(d.ingest.mock.calls[0][0].keepOriginal).toBe(false)
  })

  it("carries provider attribution when a model produced the pixels", async () => {
    const d = deps()
    await saveImageEditVersion(
      { ...base, attribution: { providerId: "openai", modelId: "gpt-image-1" } },
      d
    )
    expect(d.append.mock.calls[0][0].version).toMatchObject({
      providerId: "openai",
      modelId: "gpt-image-1",
    })
  })

  it("omits attribution fields entirely for a local edit", async () => {
    const d = deps()
    await saveImageEditVersion({ ...base, attribution: null }, d)
    const version = d.append.mock.calls[0][0].version
    expect(version).not.toHaveProperty("providerId")
    expect(version).not.toHaveProperty("modelId")
  })

  it("mints a version id when the caller supplies none", async () => {
    const d = deps()
    const result = await saveImageEditVersion(base, d)
    expect(result.version.versionId).toMatch(/^iev_/)
  })

  it("reuses the caller's version id, which is how a retry stays one version", async () => {
    const d = deps({ append: jest.fn(async () => ({ appended: false, parts: [] })) })
    const result = await saveImageEditVersion({ ...base, versionId: "iev_same" }, d)
    expect(result.version.versionId).toBe("iev_same")
    expect(result.appended).toBe(false)
  })

  it("passes the filename through when one is given, and omits it otherwise", async () => {
    const withName = deps()
    await saveImageEditVersion({ ...base, filename: "cropped.webp" }, withName)
    expect(withName.append.mock.calls[0][0].filename).toBe("cropped.webp")

    const without = deps()
    await saveImageEditVersion(base, without)
    expect(without.append.mock.calls[0][0]).not.toHaveProperty("filename")
  })

  it("records the parent so a chained edit keeps its place in the lineage", async () => {
    const d = deps()
    await saveImageEditVersion({ ...base, parentVersionId: "iev_first" }, d)
    expect(d.append.mock.calls[0][0].version.parentVersionId).toBe("iev_first")
  })

  it("propagates an append failure instead of reporting a save", async () => {
    const d = deps({
      append: jest.fn(async () => {
        throw new Error("lineage-missing")
      }),
    })
    await expect(saveImageEditVersion(base, d)).rejects.toThrow("lineage-missing")
  })

  it("never appends when ingestion fails", async () => {
    const d = deps({
      ingest: jest.fn(async () => {
        throw new Error("too large")
      }),
    })
    await expect(saveImageEditVersion(base, d)).rejects.toThrow("too large")
    expect(d.append).not.toHaveBeenCalled()
  })

  it("produces a version the reader accepts", async () => {
    const d = deps()
    const result = await saveImageEditVersion(base, d)
    expect(readImageEditVersion({ type: "file", cogniaImageEdit: result.version })).toEqual(
      result.version
    )
  })
})
