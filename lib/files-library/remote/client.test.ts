/** @jest-environment jsdom */
import type { FilesEntry } from "../types"
import {
  createFilesRemoteClient,
  FilesRemoteError,
  mediaResourcesFor,
  newFilesIntentKey,
} from "./client"
import { entryToRemote, FILES_REMOTE_MAX_BYTES } from "./types"

const SHA = "a".repeat(64)

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: `image:${SHA}`,
    kind: "image",
    sourceId: SHA,
    title: "photo",
    sourceTitle: "photo",
    projectIds: [],
    sessionIds: ["s1", "s2"],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "photo",
    ...overrides,
  }
}

function page(keys: string[], revision: string, nextPageToken?: string) {
  return {
    ok: true,
    items: keys.map((key) => entryToRemote(entry({ key, sourceId: key }))),
    imagesTruncated: false,
    revision,
    ...(nextPageToken ? { nextPageToken } : {}),
  }
}

function transport(answers: Record<string, unknown[] | ((args: unknown) => unknown)>) {
  const calls: { name: string; args: Record<string, unknown>; options?: unknown }[] = []
  const call = jest.fn(async (name: string, args?: Record<string, unknown>, options?: unknown) => {
    calls.push({ name, args: args ?? {}, options })
    const answer = answers[name]
    if (typeof answer === "function") return answer(args)
    if (!answer || answer.length === 0) throw new Error(`no answer for ${name}`)
    return answer.length === 1 ? answer[0] : answer.shift()
  })
  return { call, calls }
}

/** jsdom's File has no `arrayBuffer`; browsers' does. */
function fileOf(bytes: Uint8Array, name: string, type = "application/octet-stream"): File {
  const file = new File([new Uint8Array(bytes)], name, { type })
  return Object.assign(file, { arrayBuffer: async () => bytes.slice().buffer })
}

let keyCounter = 0
const newKey = () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, "0")}`

describe("intent keys", () => {
  it("are bare UUIDs", () => {
    expect(newFilesIntentKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})

describe("media resources", () => {
  it("tries the library pin first when Files keeps the item, then each conversation", () => {
    expect(mediaResourcesFor(entry({ favoritedAt: 1 }), "thumbnail")).toEqual([
      { kind: "session-media", sessionId: "library:files", hash: SHA, variant: "thumbnail" },
      { kind: "session-media", sessionId: "s1", hash: SHA, variant: "thumbnail" },
      { kind: "session-media", sessionId: "s2", hash: SHA, variant: "thumbnail" },
    ])
    expect(mediaResourcesFor(entry(), "canonical")?.map((r) => r.sessionId)).toEqual(["s1", "s2"])
  })

  it("reads a held original by its hash, as the original variant only", () => {
    const upload = entry({
      kind: "upload",
      sourceId: "asset-1",
      mediaHash: `original:${SHA}`,
      ownedByFiles: true,
      sessionIds: [],
    })
    expect(mediaResourcesFor(upload, "thumbnail")).toEqual([
      { kind: "session-media", sessionId: "library:files", hash: SHA, variant: "original" },
    ])
  })

  it("has none for a document or a malformed key", () => {
    expect(mediaResourcesFor(entry({ kind: "artifact", sourceId: "a1" }), "canonical")).toBeNull()
    expect(mediaResourcesFor(entry({ sourceId: "nothex" }), "canonical")).toBeNull()
  })
})

describe("list", () => {
  it("reads every page and drops repeats", async () => {
    const t = transport({
      files_library_list: [page(["a", "b"], "r1", "o2"), page(["b", "c"], "r1")],
    })
    const client = createFilesRemoteClient({ call: t.call as never }, { newKey })
    const library = await client.list(60)
    expect(library.entries.map((e) => e.key)).toEqual(["a", "b", "c"])
    // Entries come back searchable by their titles.
    expect(library.entries[0]!.searchText).toContain("photo")
    expect(t.calls[1]!.args).toMatchObject({ imageLimit: 60, pageToken: "o2" })
  })

  it("starts over when the library changes mid-read, then gives up", async () => {
    const t = transport({
      files_library_list: [page(["a"], "r1", "o1"), page(["b"], "r2"), page(["a", "b"], "r2")],
    })
    const client = createFilesRemoteClient({ call: t.call as never }, { newKey })
    expect((await client.list(60)).entries.map((e) => e.key)).toEqual(["a", "b"])

    let n = 0
    const restless = transport({
      files_library_list: () => page([`k${n}`], `r${n++}`, "o1"),
    })
    await expect(
      createFilesRemoteClient({ call: restless.call as never }).list(60)
    ).rejects.toMatchObject({ code: "files_remote_busy" })
  })

  it("raises a refusal and a malformed answer as coded errors", async () => {
    const refused = transport({ files_library_list: [{ ok: false, code: "headless_host" }] })
    await expect(createFilesRemoteClient({ call: refused.call as never }).list(60)).rejects.toEqual(
      new FilesRemoteError("headless_host")
    )
    const garbage = transport({ files_library_list: [{ ok: true, items: "x" }] })
    await expect(
      createFilesRemoteClient({ call: garbage.call as never }).list(60)
    ).rejects.toMatchObject({ code: "files_remote_invalid_answer" })
  })
})

it("reads every folder page", async () => {
  const folder = (id: string) => ({
    id,
    name: id,
    parentFolderId: "root",
    createdAt: 1,
    updatedAt: 1,
  })
  const t = transport({
    files_library_folder_list: [
      { ok: true, folders: [folder("a"), folder("b")], nextPageToken: "o2" },
      { ok: true, folders: [folder("c")] },
    ],
  })
  const folders = await createFilesRemoteClient({ call: t.call as never }).folders()
  expect(folders.map((f) => f.id)).toEqual(["a", "b", "c"])
})

describe("writes", () => {
  it("send the transport key on every write and the body key only where the host folds retries", async () => {
    const t = transport({
      files_library_trash: [{ ok: true, count: 1 }],
      files_library_duplicate: [{ ok: true, kind: "upload", key: "upload:c" }],
    })
    const client = createFilesRemoteClient({ call: t.call as never }, { newKey })
    await client.trash(["upload:u1"], 60)
    expect(t.calls[0]!.args).toEqual({ keys: ["upload:u1"], imageLimit: 60 })
    expect(t.calls[0]!.options).toEqual({ idempotencyKey: expect.any(String) })

    await client.duplicate("upload:u1", { suffix: " (copy)", fallbackName: "x", imageLimit: 60 })
    const sent = t.calls[1]!
    expect(sent.args.idempotencyKey).toBe(
      (sent.options as { idempotencyKey: string }).idempotencyKey
    )
  })

  it("raise the host's refusal code", async () => {
    const t = transport({ files_library_rename: [{ ok: false, code: "files_name_required" }] })
    await expect(
      createFilesRemoteClient({ call: t.call as never }).rename("k", " ", 60)
    ).rejects.toMatchObject({ code: "files_name_required" })
  })
})

describe("upload", () => {
  it("stages, sends chunks from the host's write head, and commits with a body key", async () => {
    const bytes = new Uint8Array(10).map((_, i) => i)
    const t = transport({
      files_library_upload_init: [
        { ok: true, uploadId: "up1", chunkSize: 4, resumeOffset: 0, complete: false },
      ],
      files_library_upload_chunk: (args) => {
        const { offset, dataBase64 } = args as { offset: number; dataBase64: string }
        return { ok: true, receivedBytes: offset + atob(dataBase64).length, complete: false }
      },
      files_library_upload_commit: [{ ok: true, key: "upload:new" }],
    })
    const progress: number[] = []
    const key = await createFilesRemoteClient({ call: t.call as never }, { newKey }).upload(
      fileOf(bytes, "a.bin"),
      { folderId: "lbf_1", onProgress: (p) => progress.push(p.uploadedBytes) }
    )
    expect(key).toBe("upload:new")
    const chunks = t.calls.filter((c) => c.name === "files_library_upload_chunk")
    expect(chunks.map((c) => c.args.offset)).toEqual([0, 4, 8])
    expect(progress).toEqual([0, 4, 8, 10])
    const init = t.calls[0]!.args
    expect(init).toMatchObject({ name: "a.bin", size: 10 })
    expect(init.hash).toMatch(/^[0-9a-f]{64}$/)
    const commit = t.calls.at(-1)!
    expect(commit.args).toMatchObject({ uploadId: "up1", folderId: "lbf_1" })
    expect(commit.args.idempotencyKey).toBeDefined()
  })

  it("resumes where the host already holds the bytes", async () => {
    const t = transport({
      files_library_upload_init: [
        { ok: true, uploadId: "up1", chunkSize: 4, resumeOffset: 0, complete: true },
      ],
      files_library_upload_commit: [{ ok: true, key: "upload:new" }],
    })
    await createFilesRemoteClient({ call: t.call as never }).upload(
      fileOf(new Uint8Array([97, 98, 99]), "a"),
      {}
    )
    expect(t.calls.map((c) => c.name)).toEqual([
      "files_library_upload_init",
      "files_library_upload_commit",
    ])
  })

  it("aborts the staged upload when a step fails", async () => {
    const t = transport({
      files_library_upload_init: [
        { ok: true, uploadId: "up1", chunkSize: 4, resumeOffset: 0, complete: false },
      ],
      files_library_upload_chunk: [{ ok: false, code: "attachment_offset_mismatch" }],
      files_library_upload_abort: [{ ok: true }],
    })
    await expect(
      createFilesRemoteClient({ call: t.call as never }).upload(fileOf(new Uint8Array(6), "a"), {})
    ).rejects.toMatchObject({ code: "attachment_offset_mismatch" })
    expect(t.calls.at(-1)!.name).toBe("files_library_upload_abort")
  })

  it("refuses a file over the paired ceiling before sending anything", async () => {
    const t = transport({})
    const big = { size: FILES_REMOTE_MAX_BYTES + 1, name: "big" } as File
    await expect(
      createFilesRemoteClient({ call: t.call as never }).upload(big, {})
    ).rejects.toMatchObject({
      code: "files_remote_too_large",
    })
    expect(t.call).not.toHaveBeenCalled()
  })
})

describe("readMedia", () => {
  const response = { bytes: new Uint8Array([1]), mediaType: "image/png" }

  it("moves on past a conversation that does not hold the bytes", async () => {
    const readBinary = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { code: "MEDIA_NOT_FOUND" }))
      .mockResolvedValueOnce(response)
    const client = createFilesRemoteClient({ call: jest.fn(), readBinary } as never)
    await expect(client.readMedia(entry(), "canonical")).resolves.toBe(response)
    expect(readBinary.mock.calls.map((c) => c[0].sessionId)).toEqual(["s1", "s2"])
  })

  it("reports too-large, missing and unsupported transports by code", async () => {
    const tooLarge = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error(), { code: "media_too_large" }))
    await expect(
      createFilesRemoteClient({ call: jest.fn(), readBinary: tooLarge } as never).readMedia(
        entry(),
        "canonical"
      )
    ).rejects.toMatchObject({ code: "files_remote_too_large" })

    const missing = jest.fn().mockRejectedValue(Object.assign(new Error(), { code: "not_found" }))
    await expect(
      createFilesRemoteClient({ call: jest.fn(), readBinary: missing } as never).readMedia(
        entry(),
        "canonical"
      )
    ).rejects.toMatchObject({ code: "files_source_missing" })

    await expect(
      createFilesRemoteClient({ call: jest.fn() } as never).readMedia(entry(), "canonical")
    ).rejects.toMatchObject({ code: "files_remote_media_unavailable" })

    await expect(
      createFilesRemoteClient({ call: jest.fn(), readBinary: jest.fn() } as never).readMedia(
        entry({ byteSize: FILES_REMOTE_MAX_BYTES + 1 }),
        "original"
      )
    ).rejects.toMatchObject({ code: "files_remote_too_large" })
  })
})

describe("readWorkspaceFile (ADR-0223 §8)", () => {
  const file = entry({
    key: "workspace-file:w1",
    kind: "workspace-file",
    sourceId: "w1",
    byteSize: 5,
  })
  const slice = (bytes: number[], size: number, eof: boolean) => ({
    ok: true,
    dataBase64: btoa(String.fromCharCode(...bytes)),
    size,
    eof,
  })

  it("reads the file a slice at a time to its end", async () => {
    const t = transport({
      files_library_read_chunk: [slice([1, 2, 3], 5, false), slice([4, 5], 5, true)],
    })
    const bytes = await createFilesRemoteClient({ call: t.call as never }).readWorkspaceFile(
      file,
      60
    )
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(t.calls.map((c) => c.args.offset)).toEqual([0, 3])
    expect(t.calls[0]!.args).toMatchObject({ key: "workspace-file:w1", imageLimit: 60 })
  })

  it("starts over once when the file changes size mid-read, then gives up", async () => {
    const t = transport({
      files_library_read_chunk: [slice([1], 5, false), slice([2], 6, false), slice([9], 1, true)],
    })
    await expect(
      createFilesRemoteClient({ call: t.call as never }).readWorkspaceFile(file, 60)
    ).resolves.toEqual(new Uint8Array([9]))
    let size = 0
    const restless = transport({ files_library_read_chunk: () => slice([1], ++size, false) })
    await expect(
      createFilesRemoteClient({ call: restless.call as never }).readWorkspaceFile(file, 60)
    ).rejects.toMatchObject({ code: "files_remote_busy" })
  })

  it("refuses what is over the paired ceiling, and raises the host's refusal", async () => {
    const t = transport({})
    await expect(
      createFilesRemoteClient({ call: t.call as never }).readWorkspaceFile(
        { ...file, byteSize: FILES_REMOTE_MAX_BYTES + 1 },
        60
      )
    ).rejects.toMatchObject({ code: "files_remote_too_large" })
    expect(t.call).not.toHaveBeenCalled()
    const gone = transport({
      files_library_read_chunk: [{ ok: false, code: "files_workspace_missing" }],
    })
    await expect(
      createFilesRemoteClient({ call: gone.call as never }).readWorkspaceFile(file, 60)
    ).rejects.toMatchObject({ code: "files_workspace_missing" })
  })
})
