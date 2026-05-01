import {
  CANVAS_COMMENTS_LABEL_KEY,
  CANVAS_COMMENTS_PERSIST_KEY,
  canvasCommentsSnapshot,
} from "./canvas-comments"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("canvasCommentsSnapshot", () => {
  it("declares persist + label keys", () => {
    expect(canvasCommentsSnapshot.key).toBe(CANVAS_COMMENTS_PERSIST_KEY)
    expect(canvasCommentsSnapshot.labelKey).toBe(CANVAS_COMMENTS_LABEL_KEY)
    expect(canvasCommentsSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures the docId→comments cache shape", () => {
    const payload = {
      state: {
        commentsByDoc: {
          "doc-1": [{ id: "c1", body: "hi", at: "2024-01-01T00:00:00.000Z" }],
        },
      },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [CANVAS_COMMENTS_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(canvasCommentsSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })
})
