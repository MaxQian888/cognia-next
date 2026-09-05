import {
  groupImageLineages,
  isImagePart,
  lineageContaining,
  newImageEditVersionId,
  readImageEditVersion,
  withImageEditVersion,
  AI_IMAGE_EDIT_OPERATIONS,
  IMAGE_EDIT_OPERATIONS,
  IMAGE_EDIT_PART_KEY,
  IMAGE_EDIT_SCHEMA_VERSION,
  type ImageEditVersionV1,
} from "./version"

function imagePart(url: string, extra: Record<string, unknown> = {}) {
  return { type: "file", url, mediaType: "image/png", ...extra }
}

function version(overrides: Partial<ImageEditVersionV1> = {}): ImageEditVersionV1 {
  return {
    schemaVersion: IMAGE_EDIT_SCHEMA_VERSION,
    lineageId: "cognia-media:origin",
    versionId: "v1",
    parentVersionId: null,
    operations: ["crop"],
    editedAt: 1000,
    ...overrides,
  }
}

describe("isImagePart", () => {
  it("accepts an image file part", () => {
    expect(isImagePart(imagePart("cognia-media:a"))).toBe(true)
  })

  it("rejects text parts, non-image files and malformed values", () => {
    expect(isImagePart({ type: "text", text: "hi" })).toBe(false)
    expect(isImagePart({ type: "file", url: "x", mediaType: "application/pdf" })).toBe(false)
    expect(isImagePart({ type: "file", mediaType: "image/png" })).toBe(false)
    expect(isImagePart(null)).toBe(false)
    expect(isImagePart(undefined)).toBe(false)
  })
})

describe("readImageEditVersion", () => {
  it("returns null for a part with no version, which is version zero", () => {
    expect(readImageEditVersion(imagePart("cognia-media:a"))).toBeNull()
  })

  it("reads a well-formed record", () => {
    const part = withImageEditVersion(imagePart("cognia-media:b"), version())
    expect(readImageEditVersion(part)).toEqual(version())
  })

  it("carries provider and model only when they are strings", () => {
    const withProvider = withImageEditVersion(
      imagePart("cognia-media:b"),
      version({ providerId: "openai", modelId: "gpt-image-1" })
    )
    expect(readImageEditVersion(withProvider)).toMatchObject({
      providerId: "openai",
      modelId: "gpt-image-1",
    })
    const bogus = { ...imagePart("c"), [IMAGE_EDIT_PART_KEY]: { ...version(), providerId: 7 } }
    expect(readImageEditVersion(bogus)).not.toHaveProperty("providerId")
  })

  it("degrades to null rather than throwing on anything malformed", () => {
    // This data crosses sync, backup and restore from other builds. A renderer
    // must never be the thing that throws on it.
    const cases: unknown[] = [
      { ...imagePart("a"), [IMAGE_EDIT_PART_KEY]: null },
      { ...imagePart("a"), [IMAGE_EDIT_PART_KEY]: "nope" },
      { ...imagePart("a"), [IMAGE_EDIT_PART_KEY]: { ...version(), schemaVersion: 99 } },
      { ...imagePart("a"), [IMAGE_EDIT_PART_KEY]: { ...version(), lineageId: "" } },
      { ...imagePart("a"), [IMAGE_EDIT_PART_KEY]: { ...version(), versionId: 4 } },
      { ...imagePart("a"), [IMAGE_EDIT_PART_KEY]: { ...version(), parentVersionId: 12 } },
    ]
    for (const value of cases) expect(readImageEditVersion(value)).toBeNull()
  })

  it("drops unrecognised operations instead of surfacing them", () => {
    const part = {
      ...imagePart("a"),
      [IMAGE_EDIT_PART_KEY]: { ...version(), operations: ["crop", "teleport", 3] },
    }
    expect(readImageEditVersion(part)?.operations).toEqual(["crop"])
  })

  it("tolerates a missing operations array and a missing timestamp", () => {
    const part = {
      ...imagePart("a"),
      [IMAGE_EDIT_PART_KEY]: { ...version(), operations: undefined, editedAt: undefined },
    }
    expect(readImageEditVersion(part)).toMatchObject({ operations: [], editedAt: 0 })
  })
})

describe("withImageEditVersion", () => {
  it("returns a new part and leaves the original untouched", () => {
    const original = imagePart("cognia-media:a")
    const tagged = withImageEditVersion(original, version())
    expect(tagged).not.toBe(original)
    expect(original).not.toHaveProperty(IMAGE_EDIT_PART_KEY)
    expect(tagged.url).toBe("cognia-media:a")
  })
})

describe("newImageEditVersionId", () => {
  it("mints distinct prefixed ids", () => {
    const ids = new Set(Array.from({ length: 50 }, newImageEditVersionId))
    expect(ids.size).toBe(50)
    expect([...ids].every((id) => id.startsWith("iev_"))).toBe(true)
  })
})

describe("operation vocabularies", () => {
  it("keeps the AI operations a subset of all operations", () => {
    for (const operation of AI_IMAGE_EDIT_OPERATIONS) {
      expect(IMAGE_EDIT_OPERATIONS).toContain(operation)
    }
  })
})

describe("groupImageLineages", () => {
  it("treats an untagged image as the origin of its own lineage", () => {
    const lineages = groupImageLineages([imagePart("cognia-media:a")])
    expect(lineages).toHaveLength(1)
    expect(lineages[0].lineageId).toBe("cognia-media:a")
    expect(lineages[0].origin?.depth).toBe(0)
    expect(lineages[0].entries).toHaveLength(1)
  })

  it("ignores non-image parts entirely", () => {
    expect(groupImageLineages([{ type: "text", text: "hello" }, null, 7])).toEqual([])
  })

  it("attaches a derived version to its origin", () => {
    const origin = imagePart("cognia-media:a")
    const edited = withImageEditVersion(
      imagePart("cognia-media:b"),
      version({ lineageId: "cognia-media:a", versionId: "v1" })
    )
    const [lineage] = groupImageLineages([origin, edited])
    expect(lineage.entries.map((entry) => entry.url)).toEqual(["cognia-media:a", "cognia-media:b"])
    expect(lineage.entries.map((entry) => entry.depth)).toEqual([0, 1])
  })

  it("orders by the parent chain, not by part order", () => {
    // A sync leg can rewrite a message's parts without preserving append order.
    const origin = imagePart("cognia-media:a")
    const first = withImageEditVersion(
      imagePart("cognia-media:b"),
      version({ lineageId: "cognia-media:a", versionId: "v1", editedAt: 10 })
    )
    const second = withImageEditVersion(
      imagePart("cognia-media:c"),
      version({
        lineageId: "cognia-media:a",
        versionId: "v2",
        parentVersionId: "v1",
        editedAt: 20,
      })
    )
    const [lineage] = groupImageLineages([second, origin, first])
    expect(lineage.entries.map((entry) => entry.url)).toEqual([
      "cognia-media:a",
      "cognia-media:b",
      "cognia-media:c",
    ])
    expect(lineage.entries.map((entry) => entry.depth)).toEqual([0, 1, 2])
  })

  it("orders siblings of one parent by edit time", () => {
    const origin = imagePart("cognia-media:a")
    const later = withImageEditVersion(
      imagePart("cognia-media:c"),
      version({ lineageId: "cognia-media:a", versionId: "v2", editedAt: 200 })
    )
    const earlier = withImageEditVersion(
      imagePart("cognia-media:b"),
      version({ lineageId: "cognia-media:a", versionId: "v1", editedAt: 100 })
    )
    const [lineage] = groupImageLineages([origin, later, earlier])
    expect(lineage.entries.map((entry) => entry.url)).toEqual([
      "cognia-media:a",
      "cognia-media:b",
      "cognia-media:c",
    ])
  })

  it("still emits a version whose parent part was deleted", () => {
    const orphan = withImageEditVersion(
      imagePart("cognia-media:c"),
      version({ lineageId: "cognia-media:a", versionId: "v2", parentVersionId: "gone" })
    )
    const [lineage] = groupImageLineages([imagePart("cognia-media:a"), orphan])
    expect(lineage.entries.map((entry) => entry.url)).toContain("cognia-media:c")
  })

  it("emits a lineage whose origin was deleted, with a null origin", () => {
    const edited = withImageEditVersion(
      imagePart("cognia-media:b"),
      version({ lineageId: "cognia-media:a" })
    )
    const [lineage] = groupImageLineages([edited])
    expect(lineage.origin).toBeNull()
    expect(lineage.lineageId).toBe("cognia-media:a")
    expect(lineage.entries).toHaveLength(1)
  })

  it("keeps separate images in separate lineages, in first-seen order", () => {
    const lineages = groupImageLineages([
      imagePart("cognia-media:a"),
      imagePart("cognia-media:b"),
      withImageEditVersion(imagePart("cognia-media:c"), version({ lineageId: "cognia-media:b" })),
    ])
    expect(lineages.map((lineage) => lineage.lineageId)).toEqual([
      "cognia-media:a",
      "cognia-media:b",
    ])
    expect(lineages[1].entries).toHaveLength(2)
  })

  it("deduplicates an image repeated in the same message", () => {
    const lineages = groupImageLineages([imagePart("cognia-media:a"), imagePart("cognia-media:a")])
    expect(lineages).toHaveLength(1)
    expect(lineages[0].entries).toHaveLength(1)
  })
})

describe("lineageContaining", () => {
  const lineages = groupImageLineages([
    imagePart("cognia-media:a"),
    withImageEditVersion(
      imagePart("cognia-media:b"),
      version({ lineageId: "cognia-media:a", versionId: "v1" })
    ),
    imagePart("cognia-media:z"),
  ])

  it("finds a lineage by any of its urls, origin or derived", () => {
    expect(lineageContaining(lineages, "cognia-media:a")?.lineageId).toBe("cognia-media:a")
    expect(lineageContaining(lineages, "cognia-media:b")?.lineageId).toBe("cognia-media:a")
    expect(lineageContaining(lineages, "cognia-media:z")?.lineageId).toBe("cognia-media:z")
  })

  it("returns null for an unknown url", () => {
    expect(lineageContaining(lineages, "cognia-media:nope")).toBeNull()
  })
})
