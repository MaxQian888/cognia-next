/** @jest-environment jsdom */
// Coverage for the optical-archive persistence bridge: snapshot→text rendering,
// the guard logic, and the fire-and-forget Dexie write (via fake-indexeddb).

import "fake-indexeddb/auto"
import { persistOpticalArchive, renderSnapshotToText, __TESTING__ } from "./optical-archive-persist"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { getOpticalArchive } from "@/lib/db/optical-archives"

// v101 Dexie cold open can exceed Jest's 5s default hook timeout under coverage.
jest.setTimeout(30_000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("renderSnapshotToText", () => {
  it("renders role-prefixed messages from string and part content", () => {
    const text = renderSnapshotToText([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }, "!"] },
    ])
    expect(text).toBe("user: hello\n\nassistant: world!")
  })

  it("returns undefined for empty / non-array input", () => {
    expect(renderSnapshotToText(undefined)).toBeUndefined()
    expect(renderSnapshotToText([])).toBeUndefined()
    expect(renderSnapshotToText([{ role: "user", content: "   " }])).toBeUndefined()
  })
})

describe("persistOpticalArchive", () => {
  const meta = (over = {}) => ({
    strategy: "optical",
    pre_tokens: 4000,
    post_tokens: 400,
    pre_messages: [{ role: "user", content: "original text here" }],
    optical: {
      sessionId: "s1",
      frameCount: 1,
      frames: [{ base64: "AAAA", width: 512, height: 64 }],
      shape: { font: "8x8", variant: "bw" },
      coverage: 1,
      readability: 0.9,
      estImageTokens: 80,
      estTextTokens: 500,
      ...over,
    },
  })

  it("returns undefined when there is no optical payload", () => {
    expect(persistOpticalArchive("c1", { strategy: "summary" })).toBeUndefined()
    expect(persistOpticalArchive("c1", { optical: { sessionId: "s1" } })).toBeUndefined() // no frames
    expect(persistOpticalArchive("c1", { optical: { frames: [] } })).toBeUndefined() // no sessionId
  })

  it("persists the archive to Dexie keyed by the boundary id, with original text", async () => {
    const id = persistOpticalArchive("compact-1", meta())
    expect(id).toBe("compact-1")
    await __TESTING__.lastWrite
    const row = await getOpticalArchive("compact-1")
    expect(row?.sessionId).toBe("s1")
    expect(row?.frames[0].base64).toBe("AAAA")
    expect(row?.preTokens).toBe(4000)
    expect(row?.readability).toBe(0.9)
    expect(row?.originalText).toBe("user: original text here")
  })

  it("defaults strategy and frame count when the sidecar omits them", async () => {
    persistOpticalArchive("compact-defaults", {
      optical: { sessionId: "s1", frames: [{ base64: "AAAA", width: 8, height: 8 }] },
    })
    await __TESTING__.lastWrite
    const row = await getOpticalArchive("compact-defaults")
    expect(row?.strategy).toBe("optical")
    expect(row?.frameCount).toBe(1) // derived from frames.length
    expect(row?.originalText).toBeUndefined() // no pre_messages
  })
})
