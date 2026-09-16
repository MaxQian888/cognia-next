import {
  catalogRecordFromDraft,
  draftFromRecord,
  emptyCatalogDraft,
  resolvedImageReference,
  toggleSizeClass,
  validateCatalogDraft,
  withDefaultSizeClass,
  type CatalogDraftField,
  type CatalogEntryDraft,
  type ResolvedCatalogImage,
} from "./catalog-entry-draft"
import type { CatalogEntryRecord } from "./environment-client"

const DIGEST = `sha256:${"a".repeat(64)}`

function image(overrides: Partial<ResolvedCatalogImage> = {}): ResolvedCatalogImage {
  return {
    registry: "ghcr.io",
    repository: "acme/dev",
    digest: DIGEST,
    tag: "22",
    user: "node",
    platforms: ["linux/amd64"],
    ...overrides,
  }
}

function draft(overrides: Partial<CatalogEntryDraft> = {}): CatalogEntryDraft {
  return {
    id: "node-22",
    label: "Node 22",
    description: "",
    image: image(),
    isolationFloor: "container",
    sizeClassIds: ["small"],
    ...overrides,
  }
}

function record(overrides: Partial<CatalogEntryRecord> = {}): CatalogEntryRecord {
  return {
    id: "node-22",
    scope: "tenant",
    label: "Node 22",
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST, tag: "22" },
    isolationFloor: "gvisor",
    sizeClassIds: ["medium", "small"],
    imageUser: "node",
    source: "build",
    provenance: { buildKey: "k" },
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }
}

describe("validateCatalogDraft", () => {
  it("accepts a complete draft", () => {
    expect(validateCatalogDraft(draft())).toEqual([])
  })

  // The same rules as `CatalogEntry::validate`, so the field is named before
  // the Host refuses the whole entry.
  it.each<[string, Partial<CatalogEntryDraft>, CatalogDraftField]>([
    ["an empty id", { id: "" }, "id"],
    ["an id with capitals", { id: "Node" }, "id"],
    ["an id starting with a dash", { id: "-node" }, "id"],
    ["an id over 64 characters", { id: `a${"b".repeat(64)}` }, "id"],
    ["a blank label", { label: "   " }, "label"],
    ["a label over 128 characters", { label: "x".repeat(129) }, "label"],
    ["a description over 2000 characters", { description: "x".repeat(2001) }, "description"],
    ["no size class", { sizeClassIds: [] }, "sizeClassIds"],
  ])("names the field for %s", (_name, overrides, field) => {
    expect(validateCatalogDraft(draft(overrides))).toEqual([
      { field, code: "catalog_entry_invalid" },
    ])
  })

  it("counts characters, not UTF-16 units, as the Host does", () => {
    expect(validateCatalogDraft(draft({ label: "镜".repeat(128) }))).toEqual([])
    expect(validateCatalogDraft(draft({ label: "😀".repeat(128) }))).toEqual([])
  })

  it("refuses to write an image nobody resolved", () => {
    expect(validateCatalogDraft(draft({ image: undefined }))).toEqual([
      { field: "image", code: "image_unresolved" },
    ])
  })

  it("refuses an image with no digest, which the Host would call unpinned", () => {
    expect(validateCatalogDraft(draft({ image: image({ digest: "" }) }))).toEqual([
      { field: "image", code: "catalog_entry_unpinned" },
    ])
  })

  // One `imageUser` cannot say two things; the editor shows the disagreement
  // instead of picking a platform's answer.
  it("refuses an image whose platforms run as different users", () => {
    expect(validateCatalogDraft(draft({ image: image({ user: null }) }))).toEqual([
      { field: "image", code: "image_user_ambiguous" },
    ])
  })

  it("reports every problem at once", () => {
    expect(
      validateCatalogDraft(draft({ id: "", label: "", image: undefined, sizeClassIds: [] }))
    ).toHaveLength(4)
  })
})

describe("catalogRecordFromDraft", () => {
  it("writes a new tenant entry by hand", () => {
    expect(catalogRecordFromDraft(draft({ description: "  Node toolchain  " }))).toEqual({
      id: "node-22",
      scope: "tenant",
      label: "Node 22",
      description: "Node toolchain",
      image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST, tag: "22" },
      isolationFloor: "container",
      sizeClassIds: ["small"],
      imageUser: "node",
      source: "manual",
      createdAt: 0,
      updatedAt: 0,
    })
  })

  it("leaves imageUser out for an image that runs as root", () => {
    const written = catalogRecordFromDraft(
      draft({ image: image({ user: undefined, tag: undefined }) })
    )
    expect(written).not.toHaveProperty("imageUser")
    expect(written?.image).not.toHaveProperty("tag")
    expect(written).not.toHaveProperty("description")
  })

  it("writes nothing while the draft has problems", () => {
    expect(catalogRecordFromDraft(draft({ label: "" }))).toBeUndefined()
    expect(catalogRecordFromDraft(draft({ image: undefined }))).toBeUndefined()
  })

  // Editing a label must not turn a built image into a hand-typed one or
  // rewrite when it was first recorded.
  it("carries forward what the editor does not own", () => {
    const existing = record()
    const written = catalogRecordFromDraft(
      { ...draftFromRecord(existing), label: "Renamed" },
      existing
    )
    expect(written).toEqual({ ...existing, label: "Renamed" })
  })

  it("keeps the existing id on an update", () => {
    const existing = record()
    expect(catalogRecordFromDraft(draft({ id: "other" }), existing)?.id).toBe("node-22")
  })

  it("drops a size class listed twice", () => {
    expect(catalogRecordFromDraft(draft({ sizeClassIds: ["a", "b", "a"] }))?.sizeClassIds).toEqual([
      "a",
      "b",
    ])
  })
})

describe("draftFromRecord", () => {
  it("opens a pinned entry already resolved", () => {
    expect(draftFromRecord(record())).toEqual({
      id: "node-22",
      label: "Node 22",
      description: "",
      image: {
        registry: "ghcr.io",
        repository: "acme/dev",
        digest: DIGEST,
        tag: "22",
        user: "node",
        platforms: [],
      },
      isolationFloor: "gvisor",
      sizeClassIds: ["medium", "small"],
    })
  })

  // A tag-only legacy entry was never pinned; saving it means resolving it.
  it("opens an unpinned entry with nothing resolved", () => {
    const legacy = record({
      image: { registry: "docker.io", repository: "library/node", tag: "22" },
      source: "legacy",
    })
    expect(draftFromRecord(legacy).image).toBeUndefined()
  })
})

describe("emptyCatalogDraft", () => {
  it("starts at the deployment floor with its first size class", () => {
    expect(emptyCatalogDraft({ isolationFloor: "vm", sizeClassId: "small" })).toEqual({
      id: "",
      label: "",
      description: "",
      isolationFloor: "vm",
      sizeClassIds: ["small"],
    })
    expect(emptyCatalogDraft({ isolationFloor: "container" }).sizeClassIds).toEqual([])
  })
})

describe("size class ordering", () => {
  it("makes a class the default by moving it first", () => {
    expect(withDefaultSizeClass(["a", "b", "c"], "c")).toEqual(["c", "a", "b"])
    expect(withDefaultSizeClass(["a"], "b")).toEqual(["b", "a"])
  })

  it("adds a class after the default and removes one wherever it is", () => {
    expect(toggleSizeClass(["a"], "b", true)).toEqual(["a", "b"])
    expect(toggleSizeClass(["a", "b"], "b", true)).toEqual(["a", "b"])
    expect(toggleSizeClass(["a", "b"], "a", false)).toEqual(["b"])
  })
})

describe("resolvedImageReference", () => {
  it("names the tag it came from and the digest it is pinned to", () => {
    expect(resolvedImageReference(image())).toBe(`ghcr.io/acme/dev:22@${DIGEST}`)
    expect(resolvedImageReference(image({ tag: undefined }))).toBe(`ghcr.io/acme/dev@${DIGEST}`)
  })
})
