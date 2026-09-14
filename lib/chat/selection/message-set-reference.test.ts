/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { formatContextSelectionsForLLM } from "@/lib/artifacts/format-selection-context"
import { citationsForSelections } from "@/lib/chat/mentions/selection-citations"
import { contextSelectionIdentity } from "@/lib/chat/mentions/selection-identity"
import {
  MAX_ENTITY_SNAPSHOT_CHARS,
  isEntitySelectionStale,
  getEntityMentionSource,
  entitySelectionFrom,
} from "@/lib/chat/mentions/entity-sources"
import { REFERENCE_PREAMBLE_OMITTED_NOTE } from "@/lib/chat/mentions/message-reference"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import {
  buildMessageSetReference,
  isMessageSetReference,
  rebuildMessageSetReference,
} from "./message-set-reference"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().messages.clear()
})
afterAll(dbFixture.dispose)

async function seed(
  id: string,
  text: string,
  { sessionId = "s1", role = "assistant", createdAt = 1, parts }: Record<string, unknown> = {}
) {
  await getDb().messages.put({
    id,
    sessionId,
    projectId: "p",
    role,
    parts: parts ?? [{ type: "text", text }],
    createdAt,
  } as never)
}

describe("buildMessageSetReference", () => {
  it("stages several messages as one reference that names each, in the order given", async () => {
    await seed("m1", "Why does the build fail?", { role: "user", createdAt: 1 })
    await seed("m2", "The lockfile is stale.", { createdAt: 2 })
    await seed("m3", "Regenerate it with pnpm install.", { createdAt: 3 })

    const sel = await buildMessageSetReference({
      sessionId: "s1",
      messageIds: ["m1", "m3", "m2", "m3"],
      capturedAt: 7,
    })

    expect(sel).toMatchObject({
      kind: "entity",
      entityKind: "message",
      entityId: "s1#m1",
      title: "user: Why does the build fail?",
      capturedAt: 7,
      href: "/?session=s1&message=m1",
      sourceSessionId: "s1",
      comment: "",
    })
    // Deduped, first occurrence kept, order as given.
    expect(sel!.members!.map((m) => m.entityId)).toEqual(["s1#m1", "s1#m3", "s1#m2"])
    expect(sel!.members![1]).toEqual({
      entityId: "s1#m3",
      title: "assistant: Regenerate it with pnpm install.",
      href: "/?session=s1&message=m3",
    })
    const body = sel!.snapshot
    expect(body).toContain("[Untrusted content below")
    expect(body.indexOf("1. user — /?session=s1&message=m1")).toBeLessThan(
      body.indexOf("2. assistant — /?session=s1&message=m3")
    )
    expect(body).toContain("3. assistant — /?session=s1&message=m2\nThe lockfile is stale.")
    expect(sel!.fingerprint).toEqual(expect.any(String))
    expect(isMessageSetReference(sel!)).toBe(true)
  })

  it("carries a tool's output, as a message reference does", async () => {
    await seed("m1", "", {
      parts: [
        { type: "text", text: "Listing the repo." },
        {
          type: "tool-bash",
          toolCallId: "t1",
          state: "output-available",
          input: { command: "ls" },
          output: "README.md\npackage.json",
        },
      ],
    })
    await seed("m2", "Two files.", { createdAt: 2 })
    const sel = await buildMessageSetReference({ sessionId: "s1", messageIds: ["m1", "m2"] })
    expect(sel!.snapshot).toContain("README.md")
  })

  // The model is told the turn had references; the chip names what was asked.
  it("names a turn sent with references by its words, and still notes them in the body", async () => {
    const { text } = composeTurnText("compare these", [{ kind: "references", text: "SECRET" }], {
      nonce: "abcdef1234",
    })
    await seed("m1", text, { role: "user", createdAt: 1 })
    await seed("m2", "They differ in one line.", { createdAt: 2 })
    const sel = await buildMessageSetReference({ sessionId: "s1", messageIds: ["m1", "m2"] })
    expect(sel!.members![0]!.title).toBe("user: compare these")
    expect(sel!.title).toBe("user: compare these")
    expect(sel!.snapshot).toContain(`compare these\n${REFERENCE_PREAMBLE_OMITTED_NOTE}`)
    expect(sel!.snapshot).not.toContain("SECRET")
  })

  it("clamps each message on its own, so one long message cannot crowd out the rest", async () => {
    await seed("big", "x".repeat(MAX_ENTITY_SNAPSHOT_CHARS + 500), { createdAt: 1 })
    await seed("small", "the conclusion", { createdAt: 2 })
    const sel = await buildMessageSetReference({ sessionId: "s1", messageIds: ["big", "small"] })
    expect(sel!.snapshot).toContain("Truncated by Cognia")
    expect(sel!.snapshot).toContain("the conclusion")
  })

  it("leaves out messages that are gone, elsewhere, or have nothing to read", async () => {
    await seed("m1", "kept")
    await seed("other", "wrong conversation", { sessionId: "s2" })
    await seed("pic", "", { parts: [] })
    await seed("m2", "also kept", { createdAt: 2 })
    const sel = await buildMessageSetReference({
      sessionId: "s1",
      messageIds: ["m1", "missing", "other", "pic", "m2"],
    })
    expect(sel!.members!.map((m) => m.entityId)).toEqual(["s1#m1", "s1#m2"])
  })

  it("is an ordinary message reference when one message is left", async () => {
    await seed("m1", "only this")
    const sel = await buildMessageSetReference({ sessionId: "s1", messageIds: ["missing", "m1"] })
    expect(sel!.members).toBeUndefined()
    expect(sel!.entityId).toBe("s1#m1")
    expect(isMessageSetReference(sel!)).toBe(false)

    // Same chip as the same message picked with `@msg:`.
    const source = getEntityMentionSource("message")!
    const candidate = { entityKind: "message" as const, id: "s1#m1", title: "Chat", searchText: "" }
    const picked = entitySelectionFrom(candidate, (await source.snapshot(candidate))!)
    expect(contextSelectionIdentity(sel!)).toBe(contextSelectionIdentity(picked))
    expect(sel!.snapshot).toBe(picked.snapshot)
  })

  it("is null when nothing can be read", async () => {
    await expect(buildMessageSetReference({ sessionId: "s1", messageIds: [] })).resolves.toBeNull()
    await expect(
      buildMessageSetReference({ sessionId: "s1", messageIds: ["missing"] })
    ).resolves.toBeNull()
  })

  it("cites every message and heads the block with their count", async () => {
    await seed("m1", "one")
    await seed("m2", "two", { createdAt: 2 })
    const sel = (await buildMessageSetReference({ sessionId: "s1", messageIds: ["m1", "m2"] }))!
    expect(citationsForSelections([sel]).map((ref) => ref.id)).toEqual([
      "message:s1#m1",
      "message:s1#m2",
    ])
    expect(formatContextSelectionsForLLM([sel], { sessionId: "s1" })).toContain(
      "2 messages from earlier in this conversation, in order:"
    )
  })

  it("goes stale when any message in it is edited", async () => {
    await seed("m1", "one")
    await seed("m2", "two", { createdAt: 2 })
    const sel = (await buildMessageSetReference({ sessionId: "s1", messageIds: ["m1", "m2"] }))!
    await expect(isEntitySelectionStale(sel)).resolves.toBe(false)
    await getDb().messages.update("m2", { parts: [{ type: "text", text: "TWO" }] } as never)
    await expect(isEntitySelectionStale(sel)).resolves.toBe(true)
  })
})

describe("rebuildMessageSetReference", () => {
  beforeEach(async () => {
    await seed("m1", "one", { createdAt: 1 })
    await seed("m2", "two", { createdAt: 2 })
    await seed("m3", "three", { createdAt: 3 })
  })

  it("reads every message again, keeping the order and the user's comment", async () => {
    const sel = (await buildMessageSetReference({
      sessionId: "s1",
      messageIds: ["m1", "m2", "m3"],
    }))!
    await getDb().messages.update("m2", { parts: [{ type: "text", text: "two, edited" }] } as never)
    const next = await rebuildMessageSetReference({ ...sel, comment: "compare these" })
    expect(next!.members!.map((m) => m.entityId)).toEqual(["s1#m1", "s1#m2", "s1#m3"])
    expect(next!.snapshot).toContain("two, edited")
    expect(next!.comment).toBe("compare these")
  })

  it("drops one message", async () => {
    const sel = (await buildMessageSetReference({
      sessionId: "s1",
      messageIds: ["m1", "m2", "m3"],
    }))!
    const next = await rebuildMessageSetReference(sel, { without: "s1#m2" })
    expect(next!.members!.map((m) => m.entityId)).toEqual(["s1#m1", "s1#m3"])
    expect(next!.snapshot).not.toContain("two")
  })

  it("becomes a single-message reference when one is left, and null when none is", async () => {
    const pair = (await buildMessageSetReference({ sessionId: "s1", messageIds: ["m1", "m2"] }))!
    const single = await rebuildMessageSetReference(pair, { without: "s1#m1" })
    expect(single!.members).toBeUndefined()
    expect(single!.entityId).toBe("s1#m2")

    await getDb().messages.bulkDelete(["m1", "m2"])
    await expect(rebuildMessageSetReference(pair)).resolves.toBeNull()
  })
})
