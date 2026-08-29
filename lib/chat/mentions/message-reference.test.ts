/** @jest-environment jsdom */

import {
  MAX_MESSAGE_SPAN,
  MESSAGE_REF_SEPARATOR,
  buildMessageReferenceText,
  clampSpan,
  formatMessageReference,
  messageRefId,
  parseMessageRefId,
  projectMessageBody,
} from "./message-reference"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

jest.setTimeout(30_000)

function textPart(value: string) {
  return { type: "text", text: value }
}

function toolPart(name: string, input: unknown, output: unknown) {
  return { type: `tool-${name}`, state: "output-available", input, output }
}

describe("message ref ids", () => {
  it("round-trips a session and a message", () => {
    const id = messageRefId("s_1", "m_1")
    expect(id).toBe(`s_1${MESSAGE_REF_SEPARATOR}m_1`)
    expect(parseMessageRefId(id)).toEqual({ sessionId: "s_1", messageId: "m_1" })
  })

  // Session ids are generated here and never contain a separator; a message id
  // from an imported transcript is whatever the exporting tool chose.
  it("splits on the first separator so an imported message id survives", () => {
    expect(parseMessageRefId("s_1#weird#id")).toEqual({ sessionId: "s_1", messageId: "weird#id" })
  })

  it.each([["nosep"], ["#m_1"], ["s_1#"], [""]])("rejects %s", (id) => {
    expect(parseMessageRefId(id)).toBeNull()
  })
})

describe("clampSpan", () => {
  it("bounds a span to what the picker may ask for", () => {
    expect(clampSpan({ before: 999, after: 999 })).toEqual({
      before: MAX_MESSAGE_SPAN,
      after: MAX_MESSAGE_SPAN,
    })
  })

  it("floors a negative or fractional span at zero", () => {
    expect(clampSpan({ before: -3, after: 1.7 })).toEqual({ before: 0, after: 1 })
  })

  it("survives a NaN rather than propagating it into a Dexie limit", () => {
    expect(clampSpan({ before: Number.NaN, after: 2 })).toEqual({ before: 0, after: 2 })
  })
})

describe("projectMessageBody", () => {
  it("keeps the readable text", () => {
    expect(projectMessageBody([textPart("hello")])).toBe("hello")
  })

  // The whole point of `@msg:`. The search projection drops outputs on purpose;
  // a reference exists precisely to carry what the tool returned.
  it("carries the tool OUTPUT the search projection drops", () => {
    const body = projectMessageBody([
      textPart("reading it now"),
      toolPart("Read", { file_path: "/tmp/a.txt" }, "the file contents"),
    ])
    expect(body).toContain("reading it now")
    expect(body).toContain("/tmp/a.txt")
    expect(body).toContain("→ the file contents")
  })

  it("labels the output so the ask and the answer do not run together", () => {
    const body = projectMessageBody([toolPart("Bash", { command: "ls" }, "a.txt\nb.txt")])
    expect(body).toMatch(/ls[\s\S]*→ a\.txt/)
  })

  it("says nothing extra for a tool call that has not returned", () => {
    const body = projectMessageBody([
      { type: "tool-Read", state: "input-available", input: { file_path: "/x" } },
    ])
    expect(body).not.toContain("→")
  })

  it("is empty for parts that are not an array", () => {
    expect(projectMessageBody(undefined)).toBe("")
    expect(projectMessageBody("nope")).toBe("")
  })
})

describe("formatMessageReference", () => {
  it("labels a single message with its role and no marker", () => {
    expect(formatMessageReference([{ role: "assistant", parts: [textPart("done")] }], 0)).toBe(
      "assistant: done"
    )
  })

  // With neighbours present the reader has to be able to tell which turn was
  // actually pointed at; with only one turn there is nothing to distinguish.
  it("marks the anchor once there are neighbours", () => {
    const out = formatMessageReference(
      [
        { role: "user", parts: [textPart("before")] },
        { role: "assistant", parts: [textPart("anchor")] },
        { role: "user", parts: [textPart("after")] },
      ],
      1
    )
    expect(out).toContain("assistant ← referenced message: anchor")
    expect(out).toContain("user: before")
    expect(out).not.toContain("user ← referenced")
  })

  it("skips a turn that projects to nothing rather than emitting a blank role", () => {
    const out = formatMessageReference(
      [
        // A step boundary carries no readable body at all. (An image DOES
        // project — `extractPlainText` renders a placeholder for it — so it is
        // the wrong fixture for "nothing to say".)
        { role: "user", parts: [{ type: "step-start" }] },
        { role: "assistant", parts: [textPart("only this")] },
      ],
      1
    )
    expect(out).toBe("assistant ← referenced message: only this")
  })

  it("still announces an image, which is not the same as saying nothing", () => {
    expect(
      formatMessageReference([{ role: "user", parts: [{ type: "image", url: "x" }] }], 0)
    ).toContain("image")
  })

  it("returns null when nothing is readable", () => {
    expect(formatMessageReference([{ role: "user", parts: [] }], 0)).toBeNull()
  })
})

describe("buildMessageReferenceText", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().messages.clear()
  })
  afterAll(dbFixture.dispose)

  async function seed(sessionId: string, count: number, base = 1_000): Promise<void> {
    await getDb().messages.bulkPut(
      Array.from({ length: count }, (_, i) => ({
        id: `${sessionId}-m${i}`,
        sessionId,
        projectId: "p",
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [textPart(`turn ${i}`)],
        createdAt: base + i,
      })) as never
    )
  }

  it("returns just the anchor for a zero span", async () => {
    await seed("s", 5)
    expect(await buildMessageReferenceText({ sessionId: "s", messageId: "s-m2" })).toBe(
      "user: turn 2"
    )
  })

  it("widens symmetrically and keeps document order", async () => {
    await seed("s", 7)
    const out = await buildMessageReferenceText({
      sessionId: "s",
      messageId: "s-m3",
      span: { before: 1, after: 1 },
    })
    expect(out).toBe("user: turn 2\n\nassistant ← referenced message: turn 3\n\nuser: turn 4")
  })

  it("widens on one side only", async () => {
    await seed("s", 7)
    const out = await buildMessageReferenceText({
      sessionId: "s",
      messageId: "s-m3",
      span: { before: 2, after: 0 },
    })
    expect(out).toContain("turn 1")
    expect(out).toContain("turn 2")
    expect(out).not.toContain("turn 4")
  })

  it("stops at the conversation's edges instead of running short", async () => {
    await seed("s", 3)
    const out = await buildMessageReferenceText({
      sessionId: "s",
      messageId: "s-m0",
      span: { before: 5, after: 5 },
    })
    expect(out).toContain("turn 0")
    expect(out).toContain("turn 2")
  })

  // Several messages routinely share a millisecond, which is why the window
  // bounds are inclusive on both sides and the anchor is excluded by ID.
  it("does not repeat the anchor when neighbours share its timestamp", async () => {
    await seed("s", 3, 1_000)
    await getDb().messages.bulkPut(
      [0, 1, 2].map((i) => ({
        id: `s-m${i}`,
        sessionId: "s",
        projectId: "p",
        role: "user",
        parts: [textPart(`turn ${i}`)],
        createdAt: 1_000,
      })) as never
    )
    const out = await buildMessageReferenceText({
      sessionId: "s",
      messageId: "s-m1",
      span: { before: 2, after: 2 },
    })
    expect(out!.match(/turn 1/g)).toHaveLength(1)
  })

  it("returns null for a message that is gone", async () => {
    await seed("s", 2)
    expect(await buildMessageReferenceText({ sessionId: "s", messageId: "nope" })).toBeNull()
  })

  // The id carries the session precisely so a reference cannot be pointed at a
  // message in a conversation it does not name.
  it("refuses a message that belongs to a different conversation", async () => {
    await seed("s", 2)
    await seed("other", 2)
    expect(await buildMessageReferenceText({ sessionId: "other", messageId: "s-m0" })).toBeNull()
  })
})
