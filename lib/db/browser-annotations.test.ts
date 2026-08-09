import type { BrowserSelection } from "@/lib/browser/protocol"
import {
  appendBrowserAnnotationThreadMessage,
  deleteBrowserAnnotation,
  deleteExpiredBrowserAnnotations,
  getBrowserAnnotation,
  listBrowserAnnotations,
  listActionableBrowserAnnotations,
  listPendingBrowserAnnotations,
  saveBrowserAnnotation,
  transitionBrowserAnnotation,
  type BrowserAnnotationRow,
} from "./browser-annotations"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const selection = {
  paneId: "browser-pane",
  tagName: "BUTTON",
  selector: "#save",
  domPath: "main > button",
  id: "save",
  classes: null,
  rect: { x: 0, y: 0, width: 100, height: 40 },
  outerHTML: '<button id="save">Save</button>',
  text: "Save",
  pageUrl: "http://localhost:3000/settings",
  pageTitle: "Settings",
} satisfies BrowserSelection

function annotation(id: string, over: Partial<BrowserAnnotationRow> = {}): BrowserAnnotationRow {
  return {
    id,
    sessionId: "session-1",
    baseUrl: "http://localhost:3000",
    selection,
    comment: "Increase contrast",
    intent: "change",
    severity: "important",
    status: "pending",
    thread: [],
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().browserAnnotations.clear()
})
afterAll(dbFixture.dispose)

it("round-trips and lists annotations by base URL and status", async () => {
  await saveBrowserAnnotation(annotation("later", { createdAt: 200 }))
  await saveBrowserAnnotation(annotation("first", { createdAt: 100 }))
  await saveBrowserAnnotation(
    annotation("other", { baseUrl: "http://localhost:4000", status: "acknowledged" })
  )

  expect(await getBrowserAnnotation("first")).toEqual(annotation("first"))
  expect((await listBrowserAnnotations("http://localhost:3000")).map(({ id }) => id)).toEqual([
    "first",
    "later",
  ])
  expect(await listBrowserAnnotations("http://localhost:3000", "acknowledged")).toEqual([])
})

it("allows forward status transitions and records the resolver", async () => {
  await saveBrowserAnnotation(annotation("a"))
  expect(await transitionBrowserAnnotation("a", "acknowledged", 200)).toBe(true)
  expect(await transitionBrowserAnnotation("a", "resolved", 300, "agent")).toBe(true)
  expect(await getBrowserAnnotation("a")).toMatchObject({
    status: "resolved",
    resolvedBy: "agent",
    updatedAt: 300,
    thread: [
      {
        id: "a:resolved:300",
        author: "agent",
        content: "Annotation resolved by agent.",
        createdAt: 300,
      },
    ],
  })
})

it("rejects terminal-to-pending transitions and unknown ids", async () => {
  await saveBrowserAnnotation(annotation("a", { status: "dismissed" }))
  expect(await transitionBrowserAnnotation("a", "pending", 200)).toBe(false)
  expect(await transitionBrowserAnnotation("missing", "resolved", 200, "human")).toBe(false)
})

it("appends thread messages without replacing history", async () => {
  await saveBrowserAnnotation(annotation("a"))
  const message = { id: "m1", author: "human" as const, content: "Why?", createdAt: 200 }
  expect(await appendBrowserAnnotationThreadMessage("a", message, 200)).toBe(true)
  expect(await appendBrowserAnnotationThreadMessage("missing", message, 200)).toBe(false)
  expect(await getBrowserAnnotation("a")).toMatchObject({ thread: [message], updatedAt: 200 })
})

it("deletes annotations idempotently", async () => {
  await saveBrowserAnnotation(annotation("a"))
  await deleteBrowserAnnotation("a")
  await expect(deleteBrowserAnnotation("a")).resolves.toBeUndefined()
  expect(await getBrowserAnnotation("a")).toBeUndefined()
})

it("sanitizes persisted URL secrets and form values", async () => {
  await saveBrowserAnnotation(
    annotation("safe", {
      selection: {
        ...selection,
        pageUrl: "http://localhost:3000/settings?token=secret#private",
        outerHTML: '<input value="secret" checked>',
      },
    })
  )
  const saved = await getBrowserAnnotation("safe")
  expect(saved?.selection.pageUrl).toBe("http://localhost:3000/settings")
  expect(saved?.selection.outerHTML).toBe("<input>")
})

it("lists pending annotations by session and expires old rows", async () => {
  await saveBrowserAnnotation(annotation("mine", { sessionId: "s1", createdAt: 100 }))
  await saveBrowserAnnotation(annotation("other", { sessionId: "s2", createdAt: 100 }))
  const now = new Date().getTime()
  await saveBrowserAnnotation(annotation("fresh", { sessionId: "s1", createdAt: now }))
  expect((await listPendingBrowserAnnotations("s1")).map((row) => row.id)).toEqual([
    "mine",
    "fresh",
  ])
  await transitionBrowserAnnotation("fresh", "acknowledged", now + 1)
  expect((await listActionableBrowserAnnotations("s1")).map((row) => row.id)).toEqual([
    "mine",
    "fresh",
  ])
  expect(await deleteExpiredBrowserAnnotations(now)).toBe(2)
  expect(await getBrowserAnnotation("fresh")).toBeDefined()
})
