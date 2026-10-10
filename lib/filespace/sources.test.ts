/** @jest-environment jsdom */
import type { ArtifactRow } from "@/lib/db/artifact-types"
import type { ListedSessionAsset } from "@/lib/db/session-assets"
import type { FileSpacePath } from "@/types/filespace"

jest.mock("@/lib/db/session-assets", () => ({ listSessionAssets: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import { listSessionAssets } from "@/lib/db/session-assets"
import { getDb } from "@/lib/db/schema"

import {
  artifactMediaType,
  disambiguatedName,
  fileSpaceSegmentName,
  findDexieEntry,
  listFileSpaceDexieEntries,
  projectArtifactEntries,
  projectUploadEntries,
} from "./sources"

const p = (value: string) => value as FileSpacePath

function asset(overrides: Partial<ListedSessionAsset>): ListedSessionAsset {
  return {
    sessionId: "s1",
    assetId: "asset-aaaaaaaa1",
    contentHash: "h",
    filename: "report.pdf",
    mediaType: "application/pdf",
    byteSize: 10,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    temporary: false,
    sourceAvailable: true,
    ...overrides,
  }
}

function artifact(overrides: Partial<ArtifactRow>): ArtifactRow {
  return {
    id: "art-1",
    sessionId: "s1",
    messageId: "m1",
    type: "code",
    language: "typescript",
    title: "Util",
    content: "export {}",
    version: 1,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as ArtifactRow
}

describe("naming", () => {
  it("turns a display name into one safe segment", () => {
    expect(fileSpaceSegmentName("a/b:c?.txt", "x")).toBe("a b c .txt")
    expect(fileSpaceSegmentName("  ", "fallback")).toBe("fallback")
    expect(fileSpaceSegmentName("..", "fallback")).toBe("fallback")
    expect(fileSpaceSegmentName("é", "x")).toBe("é")
  })

  it("disambiguates with the id, keeping the extension and dotfiles", () => {
    expect(disambiguatedName("report.pdf", "abcdefgh123")).toBe("report~abcdefgh.pdf")
    expect(disambiguatedName("Makefile", "abcdefgh")).toBe("Makefile~abcdefgh")
    expect(disambiguatedName(".env", "abcdefgh")).toBe(".env~abcdefgh")
    expect(disambiguatedName("x", "!!!")).toBe("x~x")
  })
})

describe("projectUploadEntries", () => {
  it("uses plain names when unique and the ~id form for every colliding row", () => {
    const entries = projectUploadEntries([
      asset({ assetId: "aaaaaaaa-1", filename: "report.pdf", createdAt: 1 }),
      asset({ assetId: "bbbbbbbb-2", filename: "report.pdf", createdAt: 2 }),
      asset({ assetId: "cccccccc-3", filename: "notes.md", mediaType: "text/markdown" }),
      asset({ assetId: "dddddddd-4", filename: "gone.txt", deletedAt: 5 }),
    ])
    expect(entries.map((entry) => entry.path)).toEqual([
      "/uploads/report~aaaaaaaa.pdf",
      "/uploads/report~bbbbbbbb.pdf",
      "/uploads/notes.md",
    ])
    expect(entries[0]).toMatchObject({
      mountId: "uploads",
      name: "report.pdf",
      size: 10,
      mediaType: "application/pdf",
      sourceId: "aaaaaaaa-1",
      sourceAvailable: true,
      createdAt: 1,
    })
  })
})

describe("projectArtifactEntries", () => {
  it("names artifacts by title and type extension and measures UTF-8 bytes", () => {
    const entries = projectArtifactEntries([
      artifact({ id: "a1", title: "Util", content: "你好" }),
      artifact({ id: "a2", type: "html", title: "Page", content: "<p/>" }),
    ])
    expect(entries.map((entry) => [entry.path, entry.size, entry.mediaType])).toEqual([
      ["/artifacts/Util.ts", 6, "text/plain"],
      ["/artifacts/Page.html", 4, "text/html"],
    ])
  })

  it("maps each artifact type to the media type its source is", () => {
    expect(artifactMediaType("svg")).toBe("image/svg+xml")
    expect(artifactMediaType("document")).toBe("text/markdown")
    expect(artifactMediaType("chart")).toBe("application/json")
    expect(artifactMediaType("jupyter")).toBe("application/json")
    expect(artifactMediaType("mermaid")).toBe("text/plain")
  })
})

describe("findDexieEntry", () => {
  const entries = projectUploadEntries([
    asset({ assetId: "aaaaaaaa-1", filename: "report.pdf", createdAt: 5 }),
    asset({ assetId: "bbbbbbbb-2", filename: "report.pdf", createdAt: 9 }),
    asset({ assetId: "cccccccc-3", filename: "notes.md" }),
  ])

  it("resolves the listed path, ~id forms included", () => {
    expect(findDexieEntry(entries, p("/uploads/report~bbbbbbbb.pdf"))?.sourceId).toBe("bbbbbbbb-2")
    expect(findDexieEntry(entries, p("/uploads/notes.md"))?.sourceId).toBe("cccccccc-3")
  })

  it("resolves a bare name that became ambiguous to the oldest row of that name", () => {
    expect(findDexieEntry(entries, p("/uploads/report.pdf"))?.sourceId).toBe("aaaaaaaa-1")
  })

  it("answers null for a name nobody has", () => {
    expect(findDexieEntry(entries, p("/uploads/missing.pdf"))).toBeNull()
    expect(findDexieEntry(entries, p("/artifacts/report.pdf"))).toBeNull()
  })
})

describe("listFileSpaceDexieEntries", () => {
  it("reads both mounts of one conversation, oldest first", async () => {
    ;(listSessionAssets as jest.Mock).mockResolvedValue([
      asset({ assetId: "late", filename: "b.txt", createdAt: 9 }),
      asset({ assetId: "early", filename: "a.txt", createdAt: 1 }),
    ])
    const toArray = jest.fn(async () => [artifact({ id: "a1" })])
    const equals = jest.fn(() => ({ toArray }))
    const where = jest.fn(() => ({ equals }))
    ;(getDb as jest.Mock).mockReturnValue({ artifacts: { where } })

    const listing = await listFileSpaceDexieEntries("s1")

    expect(listSessionAssets).toHaveBeenCalledWith("s1")
    expect(where).toHaveBeenCalledWith("sessionId")
    expect(equals).toHaveBeenCalledWith("s1")
    expect(listing.uploads.map((entry) => entry.sourceId)).toEqual(["early", "late"])
    expect(listing.artifacts.map((entry) => entry.sourceId)).toEqual(["a1"])
  })
})
