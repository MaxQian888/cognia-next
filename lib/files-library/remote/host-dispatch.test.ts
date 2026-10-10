/** @jest-environment jsdom */
import "fake-indexeddb/auto"

// The library's own writers are covered where they live; here they only have
// to be reached with the entries the host resolved, never the device's word.
jest.mock("@/lib/db/files-library-items", () => {
  const actual = jest.requireActual("@/lib/db/files-library-items")
  return {
    ...actual,
    restoreLibraryItems: jest.fn(async () => undefined),
    setLibraryItemsFavorite: jest.fn(async () => undefined),
    setLibraryItemsFolder: jest.fn(async () => undefined),
    touchLibraryItemOpened: jest.fn(async () => undefined),
    trashLibraryItems: jest.fn(async () => undefined),
  }
})
jest.mock("../trash", () => ({ purgeTrashedItems: jest.fn(async () => ({ retired: 1 })) }))
jest.mock("../rename", () => ({ renameFilesEntry: jest.fn(async () => undefined) }))
jest.mock("../duplicate", () => ({
  duplicateFilesEntry: jest.fn(async () => ({ kind: "upload", key: "upload:copy" })),
}))
jest.mock("../upload", () => ({
  uploadFileToLibrary: jest.fn(async () => ({ key: "upload:new" })),
}))
jest.mock("../use-in-chat", () => ({ bindEntryToSession: jest.fn(async () => undefined) }))
jest.mock("@/lib/db/sessions", () => ({
  createSession: jest.fn(async () => ({ id: "s-new" })),
  getSession: jest.fn(async () => undefined),
}))
jest.mock("@/lib/chat/session-exposure", () => ({ isSessionExposed: jest.fn(() => true) }))
jest.mock("@/lib/chat/session-write-guard", () => ({ assertSessionWritable: jest.fn() }))

import {
  restoreLibraryItems,
  setLibraryItemsFavorite,
  setLibraryItemsFolder,
  trashLibraryItems,
} from "@/lib/db/files-library-items"
import { listLibraryFolders } from "@/lib/db/files-library-folders"
import { LIBRARY_REF_SESSION_ID } from "@/lib/db/message-media-refs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { createSession, getSession } from "@/lib/db/sessions"
import { sha256Bytes } from "@/lib/ocr/hash"
import { purgeTrashedItems } from "../trash"
import { renameFilesEntry } from "../rename"
import { duplicateFilesEntry } from "../duplicate"
import type { FilesEntry } from "../types"
import { uploadFileToLibrary } from "../upload"
import { bindEntryToSession } from "../use-in-chat"
import { dispatchFilesHostCommand, type FilesHostDispatchDeps } from "./host-dispatch"
import { createFilesIdempotencyLedger } from "./idempotency"
import { FILES_REMOTE_TEXT_MAX, type FilesRemoteListPage } from "./types"

function entry(key: string, overrides: Partial<FilesEntry> = {}): FilesEntry {
  const [kind, ...rest] = key.split(":")
  return {
    key,
    kind: kind as FilesEntry["kind"],
    sourceId: rest.join(":"),
    title: key,
    sourceTitle: key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: key,
    ...overrides,
  }
}

let library: FilesEntry[]
let texts: Record<string, string | null>

function deps(over: Partial<FilesHostDispatchDeps> = {}): FilesHostDispatchDeps {
  return {
    platform: "tauri",
    loadLibrary: async () => ({ entries: library, imagesTruncated: false }),
    ledger: createFilesIdempotencyLedger(),
    readDocumentText: (e) => texts[e.key] ?? null,
    ...over,
  }
}

const CALLER = { callerDeviceId: "phone-1" }
const call = (command: string, payload: Record<string, unknown>, d = deps()) =>
  dispatchFilesHostCommand(command, { ...CALLER, ...payload }, d) as Promise<
    Record<string, unknown>
  >

beforeEach(async () => {
  await __resetDbForTesting()
  jest.clearAllMocks()
  library = [entry("artifact:a1"), entry("image:" + "f".repeat(64)), entry("upload:u1")]
  texts = {}
})

describe("host refusals", () => {
  it("answers headless_host where no Files page runs", async () => {
    await expect(call("files_library_list", {}, deps({ platform: "headless" }))).resolves.toEqual({
      ok: false,
      code: "headless_host",
    })
  })

  it("refuses a call without the caller the server stamps", async () => {
    await expect(dispatchFilesHostCommand("files_library_list", {}, deps())).resolves.toEqual({
      ok: false,
      code: "files_remote_invalid_request",
    })
  })

  it("refuses a malformed payload before touching anything", async () => {
    await expect(call("files_library_trash", { keys: "artifact:a1" })).resolves.toEqual({
      ok: false,
      code: "files_remote_invalid_request",
    })
    expect(trashLibraryItems).not.toHaveBeenCalled()
  })

  it("passes a library write's own code through", async () => {
    ;(renameFilesEntry as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "files_name_required" })
    )
    await expect(call("files_library_rename", { key: "artifact:a1", name: "x" })).resolves.toEqual({
      ok: false,
      code: "files_name_required",
    })
  })

  it("throws for a name outside the family", async () => {
    await expect(dispatchFilesHostCommand("pet_act", CALLER, deps())).rejects.toThrow()
  })
})

describe("reads", () => {
  it("pages the library in key order under one revision", async () => {
    library = Array.from({ length: 5 }, (_, i) => entry(`upload:u${4 - i}`))
    const first = (await call("files_library_list", {
      pageSize: 2,
    })) as unknown as FilesRemoteListPage
    expect(first.items.map((item) => item.key)).toEqual(["upload:u0", "upload:u1"])
    expect(first.nextPageToken).toBe("o2")
    expect(first.items[0]).not.toHaveProperty("searchText")
    const last = (await call("files_library_list", {
      pageSize: 2,
      pageToken: "o4",
    })) as unknown as FilesRemoteListPage
    expect(last.items.map((item) => item.key)).toEqual(["upload:u4"])
    expect(last.nextPageToken).toBeUndefined()
    expect(last.revision).toBe(first.revision)

    library = [...library.slice(0, 4), entry("upload:u4", { title: "renamed" })]
    const changed = (await call("files_library_list", {
      pageSize: 2,
    })) as unknown as FilesRemoteListPage
    expect(changed.revision).not.toBe(first.revision)
  })

  it("loads the library over the images the device has", async () => {
    const loadLibrary = jest.fn(async () => ({ entries: library, imagesTruncated: true }))
    const page = await call("files_library_list", { imageLimit: 120 }, deps({ loadLibrary }))
    expect(loadLibrary).toHaveBeenCalledWith(120)
    expect(page.imagesTruncated).toBe(true)
  })

  it("searches bodies but never the Trash or removed items", async () => {
    library = [
      entry("artifact:a1", { searchText: "quarterly revenue" }),
      entry("artifact:a2", { searchText: "revenue", trashedAt: 5 }),
      entry("artifact:a3", { searchText: "revenue", hidden: true }),
    ]
    const result = await call("files_library_search", { query: "revenue" })
    expect((result.items as { key: string }[]).map((hit) => hit.key)).toEqual(["artifact:a1"])
  })

  it("answers a document's text, cut at the ceiling", async () => {
    texts["artifact:a1"] = "x".repeat(FILES_REMOTE_TEXT_MAX + 5)
    const detail = await call("files_library_get", { key: "artifact:a1" })
    expect((detail.text as string).length).toBe(FILES_REMOTE_TEXT_MAX)
    expect(detail.textTruncated).toBe(true)
    // A file has no text to answer; its bytes are a binary read.
    const file = await call("files_library_get", { key: "upload:u1" })
    expect(file.text).toBeUndefined()
    await expect(call("files_library_get", { key: "upload:gone" })).resolves.toEqual({
      ok: false,
      code: "files_remote_not_found",
    })
  })

  it("pages folders in id order", async () => {
    const created: string[] = []
    for (const name of ["A", "B", "C"]) {
      const answer = await call("files_library_folder_create", {
        name,
        parentId: "root",
        idempotencyKey: `k-${name}`,
      })
      created.push(answer.folderId as string)
    }
    const first = await call("files_library_folder_list", { pageSize: 2 })
    const second = await call("files_library_folder_list", {
      pageSize: 2,
      pageToken: first.nextPageToken,
    })
    const ids = [
      ...(first.folders as { id: string }[]),
      ...(second.folders as { id: string }[]),
    ].map((folder) => folder.id)
    // Other cases' folders may share the table; these three come back in order.
    expect(ids.filter((id) => created.includes(id))).toEqual([...created].sort())
    expect(second.nextPageToken).toBeUndefined()
  })
})

describe("writes act on the host's own entries", () => {
  it("drops keys the host does not list", async () => {
    const answer = await call("files_library_favorite", {
      keys: ["artifact:a1", "artifact:forged"],
      favorite: true,
    })
    expect(answer).toEqual({ ok: true, count: 1 })
    const [sources, favorite] = (setLibraryItemsFavorite as jest.Mock).mock.calls[0]
    expect(sources.map((s: { kind: string }) => s.kind)).toEqual(["artifact"])
    expect(favorite).toBe(true)
  })

  it("moves into a folder or out of Folders", async () => {
    await call("files_library_move", { keys: ["upload:u1"], folderId: null })
    expect((setLibraryItemsFolder as jest.Mock).mock.calls[0][1]).toBeNull()
  })

  it("trashes only what is not in the Trash, and restores only what is", async () => {
    library = [entry("upload:u1"), entry("upload:u2", { trashedAt: 3, originAlive: false })]
    expect(await call("files_library_trash", { keys: ["upload:u1", "upload:u2"] })).toEqual({
      ok: true,
      count: 1,
    })
    expect(await call("files_library_restore", { keys: ["upload:u1", "upload:u2"] })).toEqual({
      ok: true,
      count: 1,
    })
    expect((restoreLibraryItems as jest.Mock).mock.calls[0][0][0]).toMatchObject({
      originAlive: false,
    })
  })

  it("ends for good only trashed items, by the host's own ownership facts", async () => {
    library = [
      entry("upload:u1", { trashedAt: 3, ownedByFiles: true }),
      entry("upload:u2", { ownedByFiles: true }),
    ]
    const answer = await call("files_library_purge", { keys: ["upload:u1", "upload:u2"] })
    expect(answer).toEqual({ ok: true, retired: 1, count: 1 })
    expect((purgeTrashedItems as jest.Mock).mock.calls[0][0]).toEqual([
      expect.objectContaining({ key: "upload:u1", ownedByFiles: true }),
    ])
    // Nothing trashed among the keys: nothing ends.
    ;(purgeTrashedItems as jest.Mock).mockClear()
    expect(await call("files_library_purge", { keys: ["upload:u2"] })).toEqual({
      ok: true,
      retired: 0,
      count: 0,
    })
    expect(purgeTrashedItems).not.toHaveBeenCalled()
  })

  it("renames under the trimmed name", async () => {
    expect(await call("files_library_rename", { key: "artifact:a1", name: "  Plan  " })).toEqual({
      ok: true,
      name: "Plan",
    })
  })
})

describe("keyed writes", () => {
  it("fold a retried duplicate onto its first answer, per device", async () => {
    const d = deps()
    const payload = { key: "upload:u1", suffix: " (copy)", fallbackName: "x", idempotencyKey: "k1" }
    const first = await call("files_library_duplicate", payload, d)
    const retry = await call("files_library_duplicate", payload, d)
    expect(retry).toBe(first)
    expect(duplicateFilesEntry).toHaveBeenCalledTimes(1)
    await dispatchFilesHostCommand(
      "files_library_duplicate",
      { ...payload, callerDeviceId: "phone-2" },
      d
    )
    expect(duplicateFilesEntry).toHaveBeenCalledTimes(2)
  })

  it("need their body key", async () => {
    await expect(
      call("files_library_duplicate", { key: "upload:u1", suffix: "c", fallbackName: "x" })
    ).resolves.toEqual({ ok: false, code: "files_remote_invalid_request" })
  })
})

describe("use in chat", () => {
  const ask = (payload: Record<string, unknown>) =>
    call("files_library_attach", {
      title: "Chat about it",
      idempotencyKey: crypto.randomUUID(),
      ...payload,
    })

  it("binds a file to the device's conversation without copying bytes", async () => {
    ;(getSession as jest.Mock).mockResolvedValueOnce({ id: "s1" })
    expect(await ask({ key: "upload:u1", sessionId: "s1" })).toEqual({
      ok: true,
      sessionId: "s1",
      created: false,
      how: "bound",
    })
    expect((bindEntryToSession as jest.Mock).mock.calls[0][1]).toBe("s1")
  })

  it("answers a document as a reference for the device's own composer", async () => {
    ;(getSession as jest.Mock).mockResolvedValueOnce({ id: "s1" })
    expect(await ask({ key: "artifact:a1", sessionId: "s1" })).toMatchObject({ how: "referenced" })
    expect(bindEntryToSession).not.toHaveBeenCalled()
  })

  it("starts a conversation when the device names none it can use", async () => {
    expect(await ask({ key: "upload:u1", sessionId: "gone" })).toMatchObject({
      sessionId: "s-new",
      created: true,
    })
    expect((createSession as jest.Mock).mock.calls[0][0]).toEqual({ title: "Chat about it" })
  })

  it("refuses a conversation that no longer takes messages", async () => {
    ;(getSession as jest.Mock).mockResolvedValueOnce({ id: "s1" })
    ;(assertSessionWritable as jest.Mock).mockImplementationOnce(() => {
      throw new Error("read-only")
    })
    expect(await ask({ key: "upload:u1", sessionId: "s1" })).toEqual({
      ok: false,
      code: "files_remote_session_unwritable",
    })
  })
})

describe("uploads", () => {
  async function stage(bytes: Uint8Array, deviceId = "phone-1") {
    return dispatchFilesHostCommand(
      "files_library_upload_init",
      {
        callerDeviceId: deviceId,
        name: "notes.bin",
        mediaType: "application/octet-stream",
        size: bytes.byteLength,
        hash: await sha256Bytes(bytes),
      },
      deps()
    ) as Promise<Record<string, unknown>>
  }

  it("stages under the library's sentinel, for any type, and files the result", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const init = await stage(bytes)
    expect(init.ok).toBe(true)
    const row = await getDb().sessionAttachmentUploads.get(init.uploadId as string)
    expect(row?.sessionId).toBe(LIBRARY_REF_SESSION_ID)

    const chunk = await call("files_library_upload_chunk", {
      uploadId: init.uploadId,
      offset: 0,
      dataBase64: btoa(String.fromCharCode(...bytes)),
    })
    expect(chunk).toMatchObject({ ok: true, receivedBytes: 4, complete: true })
    const commit = await call("files_library_upload_commit", {
      uploadId: init.uploadId,
      folderId: "lbf_1",
      idempotencyKey: "c1",
    })
    expect(commit).toEqual({ ok: true, key: "upload:new" })
    const [file, options] = (uploadFileToLibrary as jest.Mock).mock.calls[0]
    expect((file as File).name).toBe("notes.bin")
    expect((file as File).size).toBe(4)
    expect(options).toEqual({ folderId: "lbf_1" })
  })

  it("keeps another device out of an upload", async () => {
    const init = await stage(new Uint8Array([9]))
    await expect(
      dispatchFilesHostCommand(
        "files_library_upload_chunk",
        { callerDeviceId: "phone-2", uploadId: init.uploadId, offset: 0, dataBase64: "CQ==" },
        deps()
      )
    ).resolves.toEqual({ ok: false, code: "files_remote_not_found" })
    // An abort from it does nothing either.
    await dispatchFilesHostCommand(
      "files_library_upload_abort",
      { callerDeviceId: "phone-2", uploadId: init.uploadId },
      deps()
    )
    expect(await getDb().sessionAttachmentUploads.get(init.uploadId as string)).toBeDefined()
    await call("files_library_upload_abort", { uploadId: init.uploadId })
    expect(await getDb().sessionAttachmentUploads.get(init.uploadId as string)).toBeUndefined()
  })

  it("refuses a file over the paired ceiling and bad base64", async () => {
    await expect(
      call("files_library_upload_init", {
        name: "big",
        mediaType: "video/mp4",
        size: 10 * 1024 * 1024 + 1,
        hash: "a".repeat(64),
      })
    ).resolves.toEqual({ ok: false, code: "files_remote_invalid_request" })
    const init = await stage(new Uint8Array([1]))
    await expect(
      call("files_library_upload_chunk", { uploadId: init.uploadId, offset: 0, dataBase64: "@@" })
    ).resolves.toEqual({ ok: false, code: "files_remote_invalid_request" })
  })
})

it("keeps the folder writes on the real folder table", async () => {
  const created = await call("files_library_folder_create", {
    name: " Research ",
    parentId: "root",
    idempotencyKey: "f1",
  })
  const folderId = created.folderId as string
  await call("files_library_folder_rename", { folderId, name: "Papers" })
  await call("files_library_folder_style", { folderId, color: "blue" })
  const byId = async () => (await listLibraryFolders()).find((folder) => folder.id === folderId)
  expect(await byId()).toMatchObject({ name: "Papers", color: "blue" })
  await call("files_library_folder_delete", { folderId, cascade: false })
  expect(await byId()).toBeUndefined()
})
