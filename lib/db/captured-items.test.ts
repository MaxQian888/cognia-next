import "fake-indexeddb/auto"
import {
  saveCapturedItem,
  getCapturedItem,
  findCapturedByFingerprint,
  listCapturedItemsSince,
  listCapturedItems,
  deleteCapturedItem,
} from "./captured-items"
import { getDb } from "./schema"
import type { CapturedItem } from "@/types/capture"

function item(id: string, capturedAt: number, fingerprint: string): CapturedItem {
  return { id, kind: "text", text: id, capturedAt, fingerprint }
}

// Cold-opening the versioned CogniaDB under fake-indexeddb can exceed the
// default 5s hook timeout on the first test; give it headroom.
beforeEach(async () => {
  await getDb().capturedItems.clear()
}, 30_000)

describe("captured-items CRUD", () => {
  it("saves, reads, dedups by fingerprint, and deletes", async () => {
    await saveCapturedItem(item("a", 1000, "fp-a"))
    expect((await getCapturedItem("a"))?.fingerprint).toBe("fp-a")
    expect((await findCapturedByFingerprint("fp-a"))?.id).toBe("a")
    expect(await findCapturedByFingerprint("missing")).toBeUndefined()
    await deleteCapturedItem("a")
    expect(await getCapturedItem("a")).toBeUndefined()
  })

  it("lists items since a cutoff, newest first", async () => {
    await saveCapturedItem(item("old", 1000, "f1"))
    await saveCapturedItem(item("mid", 5000, "f2"))
    await saveCapturedItem(item("new", 9000, "f3"))
    const since = await listCapturedItemsSince(4000)
    expect(since.map((i) => i.id)).toEqual(["new", "mid"])
    expect((await listCapturedItems()).length).toBe(3)
  })
})
