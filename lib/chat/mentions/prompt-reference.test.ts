/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { putChatSearchText } from "@/lib/db/chat-search-text"
import { invalidateResidentCorpus } from "@/lib/chat/search/engine"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { frameSteer } from "@/lib/claude/steer"
import { ENTITY_MENTION_RESULT_LIMIT } from "./entity-sources"
import { REFERENCE_PREAMBLE_OMITTED_NOTE } from "./message-reference"
import {
  PROMPT_TITLE_MAX,
  isOwnPrompt,
  promptFingerprint,
  promptReferenceText,
  readPromptRecord,
  searchOwnPrompts,
  typedPromptOf,
} from "./prompt-reference"

// The streaming slice of the chat store is not what this suite is about, and
// importing it mounts the whole store.
jest.mock("@/lib/chat/search/pending-rows", () => ({ pendingSearchRows: () => [] }))

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await Promise.all([
    getDb().messages.clear(),
    getDb().sessions.clear(),
    getDb().chatSearchText.clear(),
  ])
  invalidateResidentCorpus()
})
afterAll(dbFixture.dispose)

interface SessionSeed {
  id: string
  title?: string
  projectId?: string
  kind?: string
  archivedAt?: number
}

async function seedSession({ id, title = `Chat ${id}`, projectId = "p", ...rest }: SessionSeed) {
  await getDb().sessions.put({
    id,
    title,
    projectId,
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  } as never)
}

interface MessageSeed {
  id: string
  sessionId?: string
  role?: string
  parts?: unknown[]
  text?: string
  createdAt?: number
  metadata?: Record<string, unknown>
  projectId?: string
}

/** A stored message plus its search projection, the way the indexer leaves them. */
async function seedMessage({
  id,
  sessionId = "s1",
  role = "user",
  text = "",
  parts = [{ type: "text", text }],
  createdAt = 1,
  metadata,
  projectId = "p",
}: MessageSeed) {
  await getDb().messages.put({
    id,
    sessionId,
    role,
    parts,
    createdAt,
    ...(metadata ? { metadata } : {}),
  } as never)
  const searchable = parts
    .map((part) => (part as { text?: string }).text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  await putChatSearchText([
    { messageId: id, sessionId, projectId, role, createdAt, text: searchable },
  ])
}

const IM_SENDER = { platformMessage: { sender: { id: "u_42", kind: "user", displayName: "Ana" } } }

describe("typedPromptOf", () => {
  it("keeps the words with their newlines", () => {
    expect(typedPromptOf([{ type: "text", text: "line one\n\n  line two" }])).toEqual({
      text: "line one\n\n  line two",
      carriedMore: false,
    })
  })

  it("drops the context envelope and says the turn carried it", () => {
    const composed = composeTurnText("compare these two", [
      { kind: "references", text: "Referenced context:\nissue body" },
    ])
    expect(typedPromptOf([{ type: "text", text: composed.text }])).toEqual({
      text: "compare these two",
      carriedMore: true,
    })
  })

  it("leaves attachments out of the words and says they were there", () => {
    expect(
      typedPromptOf([
        { type: "file", url: "cognia-media:abc", mediaType: "application/pdf" },
        { type: "text", text: "summarize this" },
      ])
    ).toEqual({ text: "summarize this", carriedMore: true })
  })

  it("removes the steer framing the app put in front of a follow-up", () => {
    expect(typedPromptOf([{ type: "text", text: frameSteer("use pnpm instead") }]).text).toBe(
      "use pnpm instead"
    )
  })

  it("has no words for an attachment-only turn", () => {
    expect(typedPromptOf([{ type: "image", url: "x" }])).toEqual({ text: "", carriedMore: true })
    expect(typedPromptOf(undefined)).toEqual({ text: "", carriedMore: false })
  })
})

describe("isOwnPrompt", () => {
  it("accepts a user turn with nobody else behind it", () => {
    expect(isOwnPrompt({ role: "user" })).toBe(true)
  })

  it("refuses an assistant turn", () => {
    expect(isOwnPrompt({ role: "assistant" })).toBe(false)
  })

  // Both of these are stored with the `user` role.
  it("refuses a message someone sent over an IM connector", () => {
    expect(isOwnPrompt({ role: "user", metadata: IM_SENDER })).toBe(false)
  })

  it("refuses a turn a shared session attributes to an author", () => {
    expect(
      isOwnPrompt({ role: "user", collaboration: { author: { kind: "human", id: "usr_b" } } })
    ).toBe(false)
  })
})

describe("reading a prompt by reference", () => {
  beforeEach(() => seedSession({ id: "s1" }))

  it("stages the words, and notes a turn that carried more than them", async () => {
    await seedMessage({ id: "m1", text: "ship the beta" })
    await expect(promptReferenceText("s1#m1")).resolves.toBe("ship the beta")

    const composed = composeTurnText("compare these two", [
      { kind: "references", text: "Referenced context:\nbody" },
    ])
    await seedMessage({ id: "m2", text: composed.text, createdAt: 2 })
    await expect(promptReferenceText("s1#m2")).resolves.toBe(
      `compare these two\n\n${REFERENCE_PREAMBLE_OMITTED_NOTE}`
    )
  })

  it("finds nothing for a row that is gone, elsewhere, not the user's, or wordless", async () => {
    await seedMessage({ id: "reply", role: "assistant", text: "done" })
    await seedMessage({ id: "im", text: "can you check", metadata: IM_SENDER })
    await seedMessage({ id: "pic", parts: [{ type: "image", url: "x" }] })
    await seedMessage({ id: "mine", text: "mine" })
    for (const id of ["s1#missing", "s1#reply", "s1#im", "s1#pic", "s2#mine", "not-a-ref"]) {
      await expect(readPromptRecord(id)).resolves.toBeNull()
    }
    await expect(promptFingerprint("s1#im")).resolves.toBeNull()
  })

  it("changes version when the words are edited, and only then", async () => {
    await seedMessage({ id: "m1", text: "ship the beta", metadata: { note: "a" } })
    const before = await promptFingerprint("s1#m1")
    await getDb().messages.update("m1", { metadata: { note: "b" } } as never)
    await expect(promptFingerprint("s1#m1")).resolves.toBe(before)
    await getDb().messages.update("m1", { parts: [{ type: "text", text: "ship the rc" }] } as never)
    await expect(promptFingerprint("s1#m1")).resolves.not.toBe(before)
  })
})

describe("searchOwnPrompts — recent", () => {
  it("offers the newest prompts, words first, linked to the turn", async () => {
    await seedSession({ id: "s1", title: "Release prep" })
    await seedMessage({ id: "old", text: "draft the changelog", createdAt: Date.UTC(2026, 8, 1) })
    await seedMessage({
      id: "new",
      text: "tag the release\nthen push",
      createdAt: Date.UTC(2026, 8, 2),
    })

    const rows = await searchOwnPrompts("", { projectId: "p" })
    expect(rows.map((row) => row.id)).toEqual(["s1#new", "s1#old"])
    expect(rows[0]).toMatchObject({
      entityKind: "prompt",
      title: "tag the release then push",
      subtitle: "Release prep · 2026-09-02",
      href: "/?session=s1&message=new",
      sourceSessionId: "s1",
      // The words exactly, for putting back in the composer.
      insertText: "tag the release\nthen push",
    })
  })

  it("leaves out assistant turns, other people's messages and attachment-only turns", async () => {
    await seedSession({ id: "s1" })
    await seedMessage({ id: "a", role: "assistant", text: "an answer", createdAt: 4 })
    await seedMessage({ id: "im", text: "from Ana", metadata: IM_SENDER, createdAt: 3 })
    await seedMessage({ id: "pic", parts: [{ type: "image", url: "x" }], createdAt: 2 })
    await seedMessage({ id: "mine", text: "my prompt", createdAt: 1 })
    const rows = await searchOwnPrompts("", {})
    expect(rows.map((row) => row.id)).toEqual(["s1#mine"])
  })

  it("shows the same words once, at their newest", async () => {
    await seedSession({ id: "s1" })
    await seedSession({ id: "s2" })
    await seedMessage({ id: "a", sessionId: "s1", text: "try again", createdAt: 1 })
    await seedMessage({ id: "b", sessionId: "s2", text: "try  again", createdAt: 3 })
    await seedMessage({ id: "c", sessionId: "s1", text: "something else", createdAt: 2 })
    const rows = await searchOwnPrompts("", {})
    expect(rows.map((row) => row.id)).toEqual(["s2#b", "s1#c"])
  })

  it("leaves out embedded and archived conversations", async () => {
    await seedSession({ id: "shown" })
    await seedSession({ id: "aside", kind: "resource-workbench" })
    await seedSession({ id: "old", archivedAt: 5 })
    await seedMessage({ id: "a", sessionId: "aside", text: "aside prompt", createdAt: 3 })
    await seedMessage({ id: "b", sessionId: "old", text: "archived prompt", createdAt: 2 })
    await seedMessage({ id: "c", sessionId: "shown", text: "listed prompt", createdAt: 1 })
    const rows = await searchOwnPrompts("", {})
    expect(rows.map((row) => row.id)).toEqual(["shown#c"])
  })

  it("stays in the active workspace, keeping rows that predate workspaces", async () => {
    await seedSession({ id: "s1" })
    await seedMessage({ id: "here", text: "in p", projectId: "p", createdAt: 3 })
    await seedMessage({ id: "there", text: "in q", projectId: "q", createdAt: 2 })
    await seedMessage({ id: "legacy", text: "no stamp", projectId: "", createdAt: 1 })
    const rows = await searchOwnPrompts("", { projectId: "p" })
    expect(rows.map((row) => row.id)).toEqual(["s1#here", "s1#legacy"])
  })

  it("caps the offered rows", async () => {
    await seedSession({ id: "s1" })
    for (let i = 0; i < ENTITY_MENTION_RESULT_LIMIT + 5; i++) {
      await seedMessage({ id: `m${i}`, text: `prompt number ${i}`, createdAt: i + 1 })
    }
    await expect(searchOwnPrompts("", {})).resolves.toHaveLength(ENTITY_MENTION_RESULT_LIMIT)
  })

  it("elides a long prompt in its title and keeps it whole for insertion", async () => {
    await seedSession({ id: "s1" })
    const long = `${"word ".repeat(60)}end`
    await seedMessage({ id: "m1", text: long })
    const [row] = await searchOwnPrompts("", {})
    expect(row!.title.length).toBeLessThanOrEqual(PROMPT_TITLE_MAX + 1)
    expect(row!.title.endsWith("…")).toBe(true)
    expect(row!.insertText).toBe(long)
  })
})

describe("searchOwnPrompts — query", () => {
  it("finds prompts by what they say, and not the replies that say it too", async () => {
    await seedSession({ id: "s1", title: "Deploys" })
    await seedMessage({ id: "q", text: "why did the staging deploy fail", createdAt: 1 })
    await seedMessage({
      id: "r",
      role: "assistant",
      text: "the staging deploy failed",
      createdAt: 2,
    })
    await seedMessage({ id: "other", text: "rename the button", createdAt: 3 })
    const rows = await searchOwnPrompts("staging deploy", {})
    expect(rows.map((row) => row.id)).toEqual(["s1#q"])
    expect(rows[0]!.insertText).toBe("why did the staging deploy fail")
  })

  it("does not offer someone else's message that matches", async () => {
    await seedSession({ id: "s1" })
    await seedMessage({
      id: "im",
      text: "please deploy staging",
      metadata: IM_SENDER,
      createdAt: 2,
    })
    await seedMessage({ id: "mine", text: "deploy staging now", createdAt: 1 })
    const rows = await searchOwnPrompts("deploy staging", {})
    expect(rows.map((row) => row.id)).toEqual(["s1#mine"])
  })

  it("keeps a search inside the active workspace", async () => {
    await seedSession({ id: "in", projectId: "p" })
    await seedSession({ id: "out", projectId: "q" })
    await seedMessage({ id: "a", sessionId: "in", text: "rotate the keys", projectId: "p" })
    await seedMessage({ id: "b", sessionId: "out", text: "rotate the keys today", projectId: "q" })
    const rows = await searchOwnPrompts("rotate", { projectId: "p" })
    expect(rows.map((row) => row.id)).toEqual(["in#a"])
  })
})
