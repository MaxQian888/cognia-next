jest.mock("@/lib/db/chat-drafts", () => {
  const actual = jest.requireActual("@/lib/db/chat-drafts")
  return { ...actual, DRAFT_ATTACHMENT_QUOTA_BYTES: 32 }
})

import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDraft } from "@/lib/db/chat-drafts"
import { getSessionAsset, putLibraryAsset, putSessionAsset } from "@/lib/db/session-assets"
import { useChatStore } from "@/stores/chat"
import {
  attachEntryToSession,
  FilesUseInChatError,
  mentionCandidateFor,
  resolveUseInChatTarget,
  stageEntryMention,
} from "./use-in-chat"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { selectComposerContextSelections } from "@/stores/chat/chat-store"
import type { FilesEntry } from "./types"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().sessions.bulkPut([
    { id: "s1", title: "s1", createdAt: 1, updatedAt: 1 } as ChatSession,
    { id: "s2", title: "s2", createdAt: 1, updatedAt: 1 } as ChatSession,
  ])
  useChatStore.setState({ activeSessionId: null })
})
afterAll(fixture.dispose)

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "kind" | "sourceId">): FilesEntry {
  return {
    key: `${overrides.kind}:${overrides.sourceId}`,
    title: "",
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

describe("mentionCandidateFor", () => {
  it("stages artifacts and canvas documents as chips, nothing else", () => {
    expect(
      mentionCandidateFor(
        entry({ kind: "artifact", sourceId: "a", title: "A", subtype: "code", language: "ts" })
      )
    ).toEqual({
      entityKind: "artifact",
      id: "a",
      title: "A",
      searchText: "",
      subtitle: "code · ts",
    })
    expect(
      mentionCandidateFor(entry({ kind: "canvas", sourceId: "c", title: "C", subtype: "text" }))
    ).toEqual({
      entityKind: "canvas",
      id: "c",
      title: "C",
      searchText: "",
      subtitle: "text",
    })
    expect(mentionCandidateFor(entry({ kind: "image", sourceId: "h" }))).toBeNull()
  })
})

describe("resolveUseInChatTarget", () => {
  it("uses the active writable conversation", async () => {
    useChatStore.setState({ activeSessionId: "s1" })
    const { session, created } = await resolveUseInChatTarget("New")
    expect(session.id).toBe("s1")
    expect(created).toBe(false)
  })

  it("creates a conversation when none is active or the active one is locked", async () => {
    await getDb().sessions.update("s1", { handoffLock: { ticketId: "t" } } as never)
    useChatStore.setState({ activeSessionId: "s1" })
    const locked = await resolveUseInChatTarget("From Files")
    expect(locked.created).toBe(true)
    expect(locked.session.title).toBe("From Files")
    useChatStore.setState({ activeSessionId: null })
    expect((await resolveUseInChatTarget("x")).created).toBe(true)
  })
})

describe("attachEntryToSession", () => {
  it("appends an image's original bytes to the draft once", async () => {
    await getDb().messageMedia.put({
      hash: "h1",
      mediaType: "image/webp",
      width: 1,
      height: 1,
      blob: new Blob(["canon"], { type: "image/webp" }),
      byteSize: 5,
      originalBlob: new Blob(["orig!"], { type: "image/png" }),
      originalMediaType: "image/png",
      createdAt: 1,
      lastUsedAt: 1,
    })
    await expect(
      attachEntryToSession(entry({ kind: "image", sourceId: "h1" }), "s1")
    ).resolves.toBe("draft")
    await attachEntryToSession(entry({ kind: "image", sourceId: "h1" }), "s1")
    const draft = await getDraft("s1")
    expect(draft?.attachments).toHaveLength(1)
    expect(draft?.attachments?.[0]).toMatchObject({
      name: "image-h1.png",
      mediaType: "image/png",
      size: 5,
    })
    expect(new TextDecoder().decode(draft!.attachments![0]!.bytes)).toBe("orig!")
  })

  it("carries a Files upload's cached extraction into the draft", async () => {
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["notes"]),
      filename: "n.md",
      mediaType: "text/markdown",
    })
    await expect(
      attachEntryToSession(entry({ kind: "upload", sourceId: "u1" }), "s2")
    ).resolves.toBe("draft")
    const draft = await getDraft("s2")
    expect(draft?.attachments?.[0]).toMatchObject({
      name: "n.md",
      mediaType: "text/markdown",
      size: 5,
    })
  })

  it("binds a source too large for a draft to the conversation instead", async () => {
    const stored = await putSessionAsset({
      sessionId: "s1",
      assetId: "a1",
      blob: new Blob(["x".repeat(64)]),
      filename: "big.log",
      mediaType: "text/plain",
    })
    const result = await attachEntryToSession(
      entry({
        kind: "session-upload",
        sourceId: stored.contentHash,
        title: "big.log",
        mediaType: "text/plain",
        assetId: "a1",
        assetSessionId: "s1",
      }),
      "s2"
    )
    expect(result).toBe("bound")
    const bound = await getDb().messageMediaRefs.where("sessionId").equals("s2").toArray()
    expect(bound).toHaveLength(1)
    expect((await getSessionAsset("s2", bound[0]!.sessionAsset!.assetId))?.blob.size).toBe(64)
    expect(await getDraft("s2")).toBeNull()
  })

  it("refuses a source whose bytes are gone and an entry kind that has no bytes", async () => {
    await expect(
      attachEntryToSession(entry({ kind: "image", sourceId: "gone" }), "s1")
    ).rejects.toMatchObject({
      code: "files_source_missing",
    })
    await expect(
      attachEntryToSession(entry({ kind: "upload", sourceId: "gone" }), "s1")
    ).rejects.toBeInstanceOf(FilesUseInChatError)
    await expect(
      attachEntryToSession(entry({ kind: "session-upload", sourceId: "gone" }), "s1")
    ).rejects.toMatchObject({ code: "files_source_missing" })
    await expect(
      attachEntryToSession(entry({ kind: "artifact", sourceId: "a" }), "s1")
    ).rejects.toMatchObject({
      code: "files_not_attachable",
    })
  })
})

describe("stageEntryMention", () => {
  beforeEach(() => {
    useArtifactStore.setState({
      canvasDocuments: {
        c1: {
          id: "c1",
          sessionId: "standalone",
          title: "Spec",
          content: "# body",
          language: "markdown",
          type: "text",
          createdAt: new Date(1),
          updatedAt: new Date(5),
        },
        blank: {
          id: "blank",
          sessionId: "standalone",
          title: "Blank",
          content: "  ",
          language: "markdown",
          type: "text",
          createdAt: new Date(1),
          updatedAt: new Date(5),
        },
      } as never,
    })
  })

  it("stages a canvas document chip in the named conversation", async () => {
    await stageEntryMention(
      entry({ kind: "canvas", sourceId: "c1", title: "Spec", subtype: "text" }),
      "s2"
    )
    const staged = selectComposerContextSelections(useChatStore.getState(), "s2")
    expect(staged).toEqual([
      expect.objectContaining({
        kind: "entity",
        entityKind: "canvas",
        entityId: "c1",
        snapshot: "# body",
      }),
    ])
  })

  it("refuses a missing, empty or non-textual source", async () => {
    await expect(
      stageEntryMention(entry({ kind: "canvas", sourceId: "gone" }), "s1")
    ).rejects.toMatchObject({
      code: "files_source_missing",
    })
    await expect(
      stageEntryMention(entry({ kind: "canvas", sourceId: "blank" }), "s1")
    ).rejects.toMatchObject({
      code: "files_source_empty",
    })
    await expect(
      stageEntryMention(entry({ kind: "image", sourceId: "h" }), "s1")
    ).rejects.toMatchObject({
      code: "files_not_attachable",
    })
  })
})
