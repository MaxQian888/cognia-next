import { normalizeFileSpacePath } from "@/lib/filespace/paths"
import type { WorkspaceEntry } from "@/lib/files/types"
import type {
  ConversationFileSpace,
  FileSpaceDexieEntry,
  FileSpaceMount,
  FileSpacePath,
} from "@/types/filespace"

import { SHARE_BLOB_CHUNK_BYTES, SHARE_MAX_BLOBS, SHARE_MAX_BLOB_BYTES } from "./blob-crypto"
import {
  ShareFileSourceUnavailableError,
  checkShareSelectionLimits,
  expandShareSelection,
  mimeForFileName,
  type FileSelectionDeps,
} from "./file-selection"

jest.mock("./file-sources", () => ({
  ...jest.requireActual("./file-sources"),
  workspaceShareSource: jest.fn((root: string, rel: string, size: number) => ({
    size,
    read: async () => new Uint8Array(),
    root,
    rel,
  })),
}))

const p = (value: string) => normalizeFileSpacePath(value) as FileSpacePath

const disk = (overrides: Partial<FileSpaceMount> = {}): FileSpaceMount => ({
  id: "workspace",
  virtualPath: "/workspace",
  backing: "disk",
  label: "repo",
  hostPath: "/repo",
  managed: false,
  role: "primary",
  writable: true,
  status: "available",
  ...overrides,
})

const dexieMount = (id: "uploads" | "artifacts"): FileSpaceMount => ({
  id,
  virtualPath: `/${id}`,
  backing: "dexie",
  label: id,
  managed: false,
  writable: false,
  status: "available",
})

const SPACE: ConversationFileSpace = {
  sessionId: "s1",
  status: "available",
  hostId: "local",
  mounts: [
    disk(),
    disk({
      id: "root:docs",
      virtualPath: "/roots/docs",
      hostPath: "/docs",
      status: "offline",
      role: "additional",
    }),
    disk({
      id: "root:web",
      virtualPath: "/roots/web",
      hostPath: undefined,
      status: "missing",
      statusReason: "no-fs-backend",
      role: "additional",
    }),
    dexieMount("uploads"),
    dexieMount("artifacts"),
  ],
}

const upload = (
  name: string,
  overrides: Partial<FileSpaceDexieEntry> = {}
): FileSpaceDexieEntry => ({
  mountId: "uploads",
  path: p(`/uploads/${name}`),
  name,
  size: 10,
  mediaType: "application/pdf",
  createdAt: 1,
  updatedAt: 1,
  sourceId: `asset-${name}`,
  sourceAvailable: true,
  ...overrides,
})

const walkEntry = (relPath: string, size = 5): WorkspaceEntry => ({
  relPath,
  absolutePath: `/repo/${relPath}`,
  isDir: false,
  size,
  mtimeMs: 1,
})

function deps(overrides: Partial<FileSelectionDeps> = {}): FileSelectionDeps {
  return {
    statWorkspaceFile: jest.fn(async (_root: string, rel: string) => {
      if (rel === "missing.txt") return { exists: false, isDir: false, size: 0, mtimeMs: null }
      if (rel === "src") return { exists: true, isDir: true, size: 0, mtimeMs: 1 }
      return { exists: true, isDir: false, size: 42, mtimeMs: 1 }
    }),
    walkWorkspaceTree: jest.fn(async () => ({
      entries: [walkEntry("src/a.ts"), walkEntry("src/b.png", 9)],
      truncated: false,
      skippedSensitive: 2,
      degraded: false,
    })),
    listFileSpaceDexieEntries: jest.fn(async () => ({
      uploads: [
        upload("report.pdf"),
        upload(".env", { mediaType: "" }),
        upload("lost.bin", { sourceAvailable: false }),
      ],
      artifacts: [
        {
          ...upload("chart.json", { mediaType: "application/json" }),
          mountId: "artifacts" as const,
          path: p("/artifacts/chart.json"),
          sourceId: "art-1",
        },
      ],
    })),
    getSessionAsset: jest.fn(async (_sessionId: string, assetId: string) =>
      assetId === "asset-report.pdf"
        ? ({ blob: new Blob(["pdf!"]) } as Awaited<
            ReturnType<FileSelectionDeps["getSessionAsset"]>
          >)
        : undefined
    ),
    getArtifactContent: jest.fn(async (id: string) => (id === "art-1" ? "{}" : undefined)),
    ...overrides,
  }
}

describe("mimeForFileName", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(mimeForFileName("a.PDF")).toBe("application/pdf")
    expect(mimeForFileName("photo.jpeg")).toBe("image/jpeg")
    expect(mimeForFileName("Makefile")).toBe("application/octet-stream")
    expect(mimeForFileName(".gitignore")).toBe("application/octet-stream")
  })
})

describe("expandShareSelection", () => {
  it("expands a disk directory through the ignore-aware walk with the floor on", async () => {
    const d = deps()
    const result = await expandShareSelection(SPACE, [p("/workspace/src")], d)
    expect(d.walkWorkspaceTree).toHaveBeenCalledWith("/repo", {
      relPath: "src",
      includeIgnored: false,
      maxEntries: SHARE_MAX_BLOBS + 1,
      sensitiveFloor: true,
    })
    expect(result.files.map((f) => [f.path, f.size, f.mime])).toEqual([
      ["/workspace/src/a.ts", 5, "text/plain"],
      ["/workspace/src/b.png", 9, "image/png"],
    ])
    expect(result.skippedSensitive).toBe(2)
    expect(result.issues).toEqual([])
  })

  it("walks a whole mount from its root", async () => {
    const d = deps()
    await expandShareSelection(SPACE, [p("/workspace")], d)
    expect(d.statWorkspaceFile).not.toHaveBeenCalled()
    expect(d.walkWorkspaceTree).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ relPath: undefined })
    )
  })

  it("keeps an individually picked sensitive file, flagged", async () => {
    const result = await expandShareSelection(SPACE, [p("/workspace/config/.env.local")], deps())
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ name: ".env.local", size: 42, sensitive: true })
  })

  it("lists each path once even when a file and its directory are both picked", async () => {
    const result = await expandShareSelection(
      SPACE,
      [p("/workspace/src/a.ts"), p("/workspace/src")],
      deps()
    )
    expect(result.files.map((f) => f.path)).toEqual(["/workspace/src/a.ts", "/workspace/src/b.png"])
  })

  it("reports paths that contribute nothing, with the reason", async () => {
    const result = await expandShareSelection(
      SPACE,
      [
        p("/workspace/missing.txt"),
        p("/roots/docs/a.md"),
        p("/roots/web/a.md"),
        p("/elsewhere/x"),
        p("/uploads/nope.pdf"),
        p("/uploads/lost.bin"),
      ],
      deps()
    )
    expect(result.files).toEqual([])
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      "not-found",
      "offline",
      "no-backend",
      "outside",
      "not-found",
      "source-unavailable",
    ])
  })

  it("expands a Dexie mount, skipping the floor and rows without bytes", async () => {
    const result = await expandShareSelection(SPACE, [p("/uploads"), p("/artifacts")], deps())
    expect(result.files.map((f) => [f.path, f.mime])).toEqual([
      ["/artifacts/chart.json", "application/json"],
      ["/uploads/report.pdf", "application/pdf"],
    ])
    expect(result.skippedSensitive).toBe(1)
  })

  it("opens upload and artifact bytes lazily and reports vanished ones", async () => {
    const d = deps()
    const result = await expandShareSelection(
      SPACE,
      [p("/uploads/report.pdf"), p("/artifacts/chart.json"), p("/uploads/.env")],
      d
    )
    const byPath = new Map(result.files.map((f) => [f.path as string, f]))
    expect(byPath.get("/uploads/.env")?.sensitive).toBe(true)
    expect(byPath.get("/uploads/.env")?.mime).toBe("application/octet-stream")
    const pdf = await byPath.get("/uploads/report.pdf")!.open()
    expect(new TextDecoder().decode(await pdf.read(0, pdf.size))).toBe("pdf!")
    const chart = await byPath.get("/artifacts/chart.json")!.open()
    expect(chart.size).toBe(2)
    await expect(byPath.get("/uploads/.env")!.open()).rejects.toBeInstanceOf(
      ShareFileSourceUnavailableError
    )
    expect(d.listFileSpaceDexieEntries).toHaveBeenCalledTimes(1)
  })

  it("stops past the share's file limit and says so", async () => {
    const many = Array.from({ length: SHARE_MAX_BLOBS + 5 }, (_, i) => walkEntry(`f${i}.txt`))
    const result = await expandShareSelection(
      SPACE,
      [p("/workspace")],
      deps({
        walkWorkspaceTree: jest.fn(async () => ({
          entries: many,
          truncated: true,
          skippedSensitive: 0,
          degraded: true,
        })),
      })
    )
    expect(result.truncated).toBe(true)
    expect(result.files).toHaveLength(SHARE_MAX_BLOBS + 1)
  })
})

describe("checkShareSelectionLimits", () => {
  it("passes a share inside every limit", () => {
    expect(checkShareSelectionLimits([{ path: p("/a"), size: SHARE_BLOB_CHUNK_BYTES }])).toEqual([])
  })

  it("reports too many files, an oversized file and an oversized total", () => {
    const tooMany = Array.from({ length: SHARE_MAX_BLOBS + 1 }, (_, i) => ({
      path: p(`/f${i}`),
      size: 1,
    }))
    expect(checkShareSelectionLimits(tooMany)).toEqual([
      { kind: "too-many-files", count: SHARE_MAX_BLOBS + 1, max: SHARE_MAX_BLOBS },
    ])
    const big = Array.from({ length: 4 }, (_, i) => ({
      path: p(`/big${i}`),
      size: SHARE_MAX_BLOB_BYTES,
    }))
    const violations = checkShareSelectionLimits([
      ...big,
      { path: p("/huge"), size: SHARE_MAX_BLOB_BYTES + 1 },
    ])
    expect(violations.map((v) => v.kind)).toEqual(["file-too-large", "total-too-large"])
  })
})
