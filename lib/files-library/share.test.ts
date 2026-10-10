import type { ChatSession } from "@cognia/agent-config-types"
import { SharedSessionAccessError } from "@/lib/collab/shared-session-access"
import { getLibraryItem } from "@/lib/db/files-library-items"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { FileShareRefusedError } from "@/lib/filespace/share-files"

import {
  authorizeFilesShare,
  FILES_SHARE_ROOT,
  filesSharePayload,
  isFilesShareAvailable,
  recordFilesShare,
  resolveFilesShareSelection,
} from "./share"
import type { FilesEntry } from "./types"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "key">): FilesEntry {
  const [kind, sourceId] = overrides.key.split(":") as [FilesEntry["kind"], string]
  return {
    kind,
    sourceId,
    title: sourceId,
    sourceTitle: sourceId,
    projectIds: [],
    sessionIds: [],
    sharedWithMe: false,
    creator: "user",
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: sourceId,
    ...overrides,
  }
}

const folders: LibraryFolder[] = [
  { id: "lbf_a", name: "Specs", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
  { id: "lbf_b", name: "Drafts", parentFolderId: "lbf_a", createdAt: 1, updatedAt: 1 },
]

describe("isFilesShareAvailable", () => {
  it("shares anything outside the Trash", () => {
    expect(isFilesShareAvailable({})).toBe(true)
    expect(isFilesShareAvailable({ trashedAt: 5 })).toBe(false)
  })
})

describe("resolveFilesShareSelection", () => {
  const blobs: Record<string, { blob: Blob; filename: string } | null> = {
    "canvas:c1": {
      blob: new Blob(["# Plan"], { type: "text/plain;charset=utf-8" }),
      filename: "plan.md",
    },
    "canvas:c2": {
      blob: new Blob(["# Other"], { type: "text/plain;charset=utf-8" }),
      filename: "PLAN.md",
    },
    "upload:u1": { blob: new Blob(["png"], { type: "image/png" }), filename: "chart.png" },
    "upload:u2": { blob: new Blob(["SECRET=1"]), filename: ".env" },
    "image:gone": null,
  }
  const payloadFor = async (e: FilesEntry) => blobs[e.key] ?? null

  it("names files by their place in Files, numbering clashes, and opens their bytes lazily", async () => {
    const getSessions = jest.fn(async () => [])
    const selection = await resolveFilesShareSelection(
      [
        entry({ key: "canvas:c1", folderId: "lbf_b" }),
        entry({ key: "canvas:c2", folderId: "lbf_b" }),
        entry({ key: "upload:u1", mediaType: "image/png", folderId: "root" }),
        entry({ key: "image:gone" }),
      ],
      folders,
      { payloadFor, getSessions }
    )
    expect(selection.files.map((file) => [file.path, file.name, file.mime, file.size])).toEqual([
      [`${FILES_SHARE_ROOT}/Specs/Drafts/plan.md`, "plan.md", "text/markdown", 6],
      [`${FILES_SHARE_ROOT}/Specs/Drafts/PLAN (2).md`, "PLAN.md", "text/markdown", 7],
      [`${FILES_SHARE_ROOT}/chart.png`, "chart.png", "image/png", 3],
    ])
    expect(selection.files.every((file) => !file.sensitive)).toBe(true)
    expect(selection.missing.map((e) => e.key)).toEqual(["image:gone"])
    expect([...selection.keyByPath.values()]).toEqual(["canvas:c1", "canvas:c2", "upload:u1"])
    expect(selection.sessions).toEqual([])

    const source = await selection.files[0]!.open()
    expect(source.size).toBe(6)
    expect(new TextDecoder().decode(await source.read(0, 6))).toBe("# Plan")
  })

  it("flags a file the sensitive floor refuses", async () => {
    const selection = await resolveFilesShareSelection([entry({ key: "upload:u2" })], [], {
      payloadFor,
      getSessions: async () => [],
    })
    expect(selection.files).toMatchObject([{ path: "/files/.env", sensitive: true }])
  })

  it("collects the collaboration conversations the items belong to", async () => {
    const shared = { id: "shared:x", collaboration: { orgId: "o", sessionId: "x" } }
    const getSessions = jest.fn(
      async () => [shared, { id: "s1" }] as unknown as Pick<ChatSession, "id" | "collaboration">[]
    )
    const selection = await resolveFilesShareSelection(
      [
        entry({ key: "canvas:c1", originSessionId: "shared:x", sessionIds: ["shared:x"] }),
        entry({ key: "upload:u1", sessionIds: ["s1"] }),
      ],
      [],
      { payloadFor, getSessions }
    )
    expect(getSessions).toHaveBeenCalledWith(["shared:x", "s1"])
    expect(selection.sessions).toEqual([shared])
  })
})

describe("authorizeFilesShare", () => {
  const session = (id: string) =>
    ({ id, collaboration: { orgId: "o", sessionId: id } }) as unknown as Pick<
      ChatSession,
      "id" | "collaboration"
    >

  it("asks every conversation, then loads the newest policy any answer named", async () => {
    const authorizeSharedSession = jest
      .fn()
      .mockResolvedValueOnce({ orgId: "o", policyRevision: 3 })
      .mockResolvedValueOnce({ orgId: "o", policyRevision: 7 })
    const loadPolicy = jest.fn().mockResolvedValue({})
    await authorizeFilesShare([session("a"), session("b")], { authorizeSharedSession, loadPolicy })
    expect(authorizeSharedSession).toHaveBeenCalledTimes(2)
    expect(loadPolicy).toHaveBeenCalledWith({ minOrgRevision: 7 })
  })

  it("does nothing for items outside any collaboration conversation", async () => {
    const authorizeSharedSession = jest.fn()
    const loadPolicy = jest.fn()
    await authorizeFilesShare([], { authorizeSharedSession, loadPolicy })
    expect(authorizeSharedSession).not.toHaveBeenCalled()
    expect(loadPolicy).not.toHaveBeenCalled()
  })

  it("refuses the whole share when one conversation forbids it", async () => {
    const authorizeSharedSession = jest
      .fn()
      .mockResolvedValueOnce({ orgId: "o", policyRevision: 1 })
      .mockRejectedValueOnce(new SharedSessionAccessError("forbidden"))
    const loadPolicy = jest.fn()
    await expect(
      authorizeFilesShare([session("a"), session("b")], { authorizeSharedSession, loadPolicy })
    ).rejects.toEqual(new FileShareRefusedError("shared-session-forbidden"))
    expect(loadPolicy).not.toHaveBeenCalled()
  })

  it("reads an unreachable plane as unavailable", async () => {
    await expect(
      authorizeFilesShare([session("a")], {
        authorizeSharedSession: jest.fn().mockRejectedValue(new Error("offline")),
        loadPolicy: jest.fn(),
      })
    ).rejects.toMatchObject({ reason: "shared-session-unavailable" })
  })
})

describe("filesSharePayload", () => {
  it("is a file bundle with the given title", () => {
    expect(filesSharePayload("3 files")).toEqual({
      kind: "file-bundle",
      mime: "application/json",
      data: "",
      encoding: "utf8",
      title: "3 files",
    })
  })
})

describe("recordFilesShare", () => {
  it("records the link on every shared item and forgets links that are gone", async () => {
    const link = (code: string, revoked: boolean) => ({
      id: `sl_${code}`,
      code,
      kind: "file-bundle" as const,
      url: "https://share.example/share/view?c=" + code,
      createdAt: 1,
      burnAfterRead: false,
      hasPassphrase: false,
      revoked,
    })
    await getDb().sharedLinks.bulkPut([link("old", true), link("kept", false), link("new", false)])
    await getDb().libraryItems.put({
      key: "canvas:c1",
      kind: "canvas",
      sourceId: "c1",
      sharedLinkCodes: ["old", "kept"],
      createdAt: 1,
      updatedAt: 1,
    })
    await recordFilesShare([entry({ key: "canvas:c1" }), entry({ key: "artifact:a1" })], "new")
    expect((await getLibraryItem("canvas:c1"))!.sharedLinkCodes).toEqual(["kept", "new"])
    expect((await getLibraryItem("artifact:a1"))!.sharedLinkCodes).toEqual(["new"])
    expect(await getDb().libraryItems.count()).toBe(2)
  })
})
