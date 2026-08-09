import type { RecordedFlow } from "@/lib/browser/recording/protocol"
import {
  deleteRecording,
  getRecording,
  listRecordingsForBase,
  renameRecording,
  saveRecording,
} from "./browser-recordings"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const LOCAL = "http://localhost:3000"
const OTHER = "http://localhost:4000"

function flow(id: string, over: Partial<RecordedFlow> = {}): RecordedFlow {
  return {
    id,
    name: id,
    baseUrl: LOCAL,
    createdAt: 1000,
    updatedAt: 1000,
    steps: [{ act: "navigate", at: 0, url: LOCAL }],
    ...over,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().browserRecordings.clear()
})
afterAll(dbFixture.dispose)

describe("saveRecording / getRecording", () => {
  it("round-trips a flow with its steps intact", async () => {
    const saved = flow("f1", {
      steps: [
        { act: "navigate", at: 0, url: `${LOCAL}/login` },
        {
          act: "fill",
          at: 1,
          target: { selector: "#email", role: "textbox", name: "Email", domPath: "form > input" },
          value: "a@b.c",
        },
      ],
    })
    await saveRecording(saved)
    expect(await getRecording("f1")).toEqual(saved)
  })

  it("replaces a flow wholesale on re-save", async () => {
    await saveRecording(flow("f1", { name: "first" }))
    await saveRecording(flow("f1", { name: "second", steps: [] }))
    const row = await getRecording("f1")
    expect(row?.name).toBe("second")
    expect(row?.steps).toEqual([])
    expect(await listRecordingsForBase(LOCAL)).toHaveLength(1)
  })

  it("returns undefined for an unknown id", async () => {
    expect(await getRecording("nope")).toBeUndefined()
  })

  // Only proves Dexie round-trips what it was handed. The real guarantee — that
  // a secret's value is never captured in the first place — belongs to the
  // recorder, upstream of this layer.
  it("round-trips the secret flag", async () => {
    await saveRecording(
      flow("f1", {
        steps: [
          {
            act: "fill",
            at: 1,
            target: { selector: "#pw", role: "textbox", name: "Password", domPath: "form > input" },
            value: "",
            secret: true,
          },
        ],
      })
    )
    const row = await getRecording("f1")
    expect(row?.steps[0]).toMatchObject({ secret: true, value: "" })
  })
})

describe("listRecordingsForBase", () => {
  it("returns only the flows recorded against that origin", async () => {
    await saveRecording(flow("a", { baseUrl: LOCAL }))
    await saveRecording(flow("b", { baseUrl: OTHER }))
    expect((await listRecordingsForBase(LOCAL)).map((f) => f.id)).toEqual(["a"])
  })

  it("orders that origin's flows newest first", async () => {
    await saveRecording(flow("older", { baseUrl: LOCAL, updatedAt: 1000 }))
    await saveRecording(flow("newer", { baseUrl: LOCAL, updatedAt: 5000 }))
    expect((await listRecordingsForBase(LOCAL)).map((f) => f.id)).toEqual(["newer", "older"])
  })

  it("is empty to begin with", async () => {
    expect(await listRecordingsForBase(LOCAL)).toEqual([])
  })

  it("orders by recency, newest first", async () => {
    await saveRecording(flow("old", { updatedAt: 1000 }))
    await saveRecording(flow("new", { updatedAt: 3000 }))
    await saveRecording(flow("mid", { updatedAt: 2000 }))
    expect((await listRecordingsForBase(LOCAL)).map((f) => f.id)).toEqual(["new", "mid", "old"])
  })

  it("is empty for an origin with no flows", async () => {
    await saveRecording(flow("a", { baseUrl: LOCAL }))
    expect(await listRecordingsForBase("http://localhost:9999")).toEqual([])
  })
})

describe("renameRecording", () => {
  it("renames and stamps updatedAt", async () => {
    await saveRecording(flow("f1", { name: "untitled", updatedAt: 1000 }))
    expect(await renameRecording("f1", "login flow", 7000)).toBe(true)
    expect(await getRecording("f1")).toMatchObject({ name: "login flow", updatedAt: 7000 })
  })

  it("reports false when the row went away underneath the caller", async () => {
    expect(await renameRecording("ghost", "x", 7000)).toBe(false)
  })
})

describe("deleteRecording", () => {
  it("removes the flow", async () => {
    await saveRecording(flow("f1"))
    await deleteRecording("f1")
    expect(await getRecording("f1")).toBeUndefined()
  })

  it("is a no-op for an unknown id", async () => {
    await expect(deleteRecording("ghost")).resolves.toBeUndefined()
  })
})
