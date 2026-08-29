/** @jest-environment jsdom */

import { formatResultPart, parseResultId, resultBodyText } from "./result-reference"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

jest.setTimeout(30_000)

describe("parseResultId", () => {
  it("splits a message id from its part index", () => {
    expect(parseResultId("m_1:3")).toEqual({ messageId: "m_1", partIndex: 3 })
  })

  // Split on the LAST separator: the index is always the trailing number, but
  // an imported transcript's message id may itself contain a colon.
  it("keeps a colon inside the message id", () => {
    expect(parseResultId("claude:sess:42:0")).toEqual({
      messageId: "claude:sess:42",
      partIndex: 0,
    })
  })

  it.each([["nosep"], [":3"], ["m_1:"], ["m_1:x"], ["m_1:-1"], ["m_1:1.5"], [""]])(
    "rejects %s",
    (id) => {
      expect(parseResultId(id)).toBeNull()
    }
  )
})

describe("formatResultPart", () => {
  // A bare wall of stdout tells the model nothing about whether it is reading a
  // file, a search, or a failed command — and that decides how far to trust it.
  it("heads a tool result with the tool that produced it", () => {
    expect(
      formatResultPart({ type: "tool-Read", state: "output-available", output: "file body" })
    ).toBe("Result of Read:\nfile body")
  })

  it("carries a failed call, which is also a result people reference", () => {
    expect(
      formatResultPart({ type: "tool-Bash", state: "output-error", errorText: "exit 1" })
    ).toContain("exit 1")
  })

  // An artifact part is a POINTER (`artifactId` + a title snapshot) whose body
  // lives in `useArtifactStore`, where `@artifact:` reads it live. Reading it
  // here too would give one document two bodies, and the stale one would be the
  // one inlined into a prompt.
  it.each([
    ["a tool call still running", { type: "tool-Read", state: "input-available" }],
    ["an artifact pointer", { type: "artifact", artifactId: "a1", title: "parser.ts" }],
    ["a canvas pointer", { type: "canvas", canvasId: "c1", title: "Notes" }],
    ["a plain text part", { type: "text", text: "hello" }],
    ["a non-object", "nope"],
  ])("returns null for %s", (_label, part) => {
    expect(formatResultPart(part)).toBeNull()
  })
})

describe("resultBodyText", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().messages.clear()
  })
  afterAll(dbFixture.dispose)

  async function seed(parts: unknown[]): Promise<void> {
    await getDb().messages.put({
      id: "m1",
      sessionId: "s1",
      projectId: "p",
      role: "assistant",
      parts,
      createdAt: 1,
    } as never)
  }

  it("reads the body back from the owning message, not from the index", async () => {
    await seed([
      { type: "text", text: "here" },
      { type: "tool-Read", state: "output-available", output: "the whole file, not a preview" },
    ])
    expect(await resultBodyText("m1:1")).toContain("the whole file, not a preview")
  })

  // Three real cases, one honest answer: the message was deleted, it was edited
  // so nothing sits at that index any more, or the part no longer produces
  // readable output. In each the caller must say the record is unavailable.
  it("returns null for a message that is gone", async () => {
    expect(await resultBodyText("missing:0")).toBeNull()
  })

  it("returns null when the part index no longer exists", async () => {
    await seed([{ type: "text", text: "only one part" }])
    expect(await resultBodyText("m1:7")).toBeNull()
  })

  it("returns null when the part at that index is no longer a result", async () => {
    await seed([{ type: "text", text: "edited away" }])
    expect(await resultBodyText("m1:0")).toBeNull()
  })

  it("returns null for a malformed id rather than reading anything", async () => {
    expect(await resultBodyText("garbage")).toBeNull()
  })
})
