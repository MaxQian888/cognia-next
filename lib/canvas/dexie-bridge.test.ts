/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

// We mock the db, the stores, and the logger so we can drive every code
// path in dexie-bridge.ts without standing up the entire data layer.

const fakeTable = () => {
  const records: Record<string, unknown>[] = []
  return {
    records,
    toArray: jest.fn(async () => [...records]),
    bulkPut: jest.fn(async (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const idx = records.findIndex((r) => r.id === row.id)
        if (idx >= 0) records[idx] = row
        else records.push(row)
      }
    }),
    bulkDelete: jest.fn(async (ids: string[]) => {
      for (const id of ids) {
        const idx = records.findIndex((r) => r.id === id)
        if (idx >= 0) records.splice(idx, 1)
      }
    }),
    delete: jest.fn(async (id: string) => {
      const idx = records.findIndex((r) => r.id === id)
      if (idx >= 0) records.splice(idx, 1)
    }),
    where: jest.fn(() => ({
      equals: jest.fn(() => ({
        delete: jest.fn(async () => 0),
        toArray: jest.fn(async () => [...records]),
      })),
    })),
  }
}

let canvasDocumentsTable = fakeTable()
let canvasVersionsTable = fakeTable()
let contextCommentsTable = fakeTable()
let canvasSessionsTable = fakeTable()

const fakeDb = {
  name: "cognia-db",
  canvasDocuments: canvasDocumentsTable,
  canvasVersions: canvasVersionsTable,
  contextComments: contextCommentsTable,
  canvasSessions: canvasSessionsTable,
  transaction: jest.fn(async (..._args: unknown[]) => {
    const fn = _args[_args.length - 1] as () => Promise<void>
    await fn()
  }),
}

jest.mock("@/lib/db/schema", () => ({
  __esModule: true,
  getDb: () => fakeDb,
}))

// Build minimal subscribe-able store mocks. Each `getState()` returns the
// current stored value; `subscribe` invokes the callback whenever
// `setState` is called from inside the test.
function makeFakeStore<T>(initial: T) {
  let state = initial
  const subs = new Set<(s: T) => void>()
  const subscribe = (fn: (s: T) => void) => {
    subs.add(fn)
    return () => {
      subs.delete(fn)
    }
  }
  return {
    getState: () => state,
    setState: (updater: T | ((prev: T) => T)) => {
      state = typeof updater === "function" ? (updater as (prev: T) => T)(state) : updater
      for (const fn of subs) fn(state)
    },
    subscribe,
    _resetTo: (next: T) => {
      state = next
    },
    _clearSubscribers: () => subs.clear(),
  }
}

const artifactStore = makeFakeStore<{
  canvasDocuments: Record<string, Record<string, unknown>>
}>({ canvasDocuments: {} })

const commentStore = makeFakeStore<{ comments: Record<string, unknown[]> }>({
  comments: {},
})

// Identity, not the real coercer: this suite is about what the mirror reads
// and writes, and the store's own tests own which fields are dates. The spy
// exists so one test can prove hydration still routes rows through it — the
// only place the ISO strings a backup restore leaves behind become Dates.
const rehydrateCanvasDocumentSpy = jest.fn(
  (doc: Record<string, unknown>) => doc as Record<string, unknown>
)
jest.mock("@/stores/artifact/artifact-store", () => ({
  __esModule: true,
  useArtifactStore: artifactStore,
  rehydrateCanvasDocument: (doc: Record<string, unknown>) => rehydrateCanvasDocumentSpy(doc),
}))

jest.mock("@/stores/canvas/comment-store", () => ({
  __esModule: true,
  useCommentStore: commentStore,
}))

jest.mock("@cognia/logging", () => ({
  __esModule: true,
  loggers: {
    canvas: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  },
}))

beforeEach(() => {
  jest.resetModules()
  // Recreate fresh tables for each test.
  canvasDocumentsTable = fakeTable()
  canvasVersionsTable = fakeTable()
  contextCommentsTable = fakeTable()
  canvasSessionsTable = fakeTable()
  fakeDb.canvasDocuments = canvasDocumentsTable
  fakeDb.canvasVersions = canvasVersionsTable
  fakeDb.contextComments = contextCommentsTable
  fakeDb.canvasSessions = canvasSessionsTable
  fakeDb.name = "cognia-db"
  rehydrateCanvasDocumentSpy.mockClear()
  fakeDb.transaction = jest.fn(async (..._args: unknown[]) => {
    const fn = _args[_args.length - 1] as () => Promise<void>
    await fn()
  })
  artifactStore._resetTo({ canvasDocuments: {} })
  commentStore._resetTo({ comments: {} })
  artifactStore._clearSubscribers()
  commentStore._clearSubscribers()
})

/** The bridge debounces its mirror by 500ms; wait past it. */
const DOCUMENT_SYNC_WAIT_MS = 700

describe("startCanvasDexieBridge", () => {
  it("starts subscriptions, hydrates, and returns a disposer", async () => {
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    expect(typeof dispose).toBe("function")
    // Wait for hydrate microtasks.
    await Promise.resolve()
    await Promise.resolve()
    dispose()
  })

  it("subsequent starts are no-ops on the same module instance", async () => {
    const mod = await import("./dexie-bridge")
    const dispose1 = mod.startCanvasDexieBridge()
    const dispose2 = mod.startCanvasDexieBridge()
    // The second call returns a noop disposer.
    expect(typeof dispose2).toBe("function")
    await Promise.resolve()
    dispose1()
    dispose2()
  })

  it("hydrates documents from Dexie when memory is empty", async () => {
    canvasDocumentsTable.records.push({
      id: "doc-1",
      sessionId: "s1",
      title: "T",
      content: "c",
      language: "ts",
      type: "code",
      createdAt: 1000,
      updatedAt: 1500,
    })
    canvasVersionsTable.records.push({
      id: "v-1",
      documentId: "doc-1",
      content: "old",
      title: "T",
      createdAt: 100,
      isAutoSave: false,
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const docs = artifactStore.getState().canvasDocuments
    expect(docs["doc-1"]).toBeDefined()
    dispose()
  })

  it("syncs documents and versions to Dexie when artifact store changes", async () => {
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await Promise.resolve()
    await Promise.resolve()

    artifactStore.setState({
      canvasDocuments: {
        "doc-2": {
          id: "doc-2",
          sessionId: "s2",
          projectId: "project-1",
          title: "Two",
          content: "data",
          language: "md",
          type: "doc",
          createdAt: new Date(2000),
          updatedAt: new Date(3000),
          versions: [
            {
              id: "v-2",
              content: "data",
              title: "Two",
              createdAt: new Date(2500),
            },
          ],
        },
      },
    })

    // The mirror is debounced: Dexie is a backup of an authoritative
    // Zustand+localStorage copy, so a typing burst coalesces into one
    // transaction instead of one per keystroke.
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))
    await Promise.resolve()
    await Promise.resolve()

    expect(canvasDocumentsTable.bulkPut).toHaveBeenCalled()
    expect(canvasDocumentsTable.bulkPut.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "doc-2", projectId: "project-1" })])
    )
    expect(canvasVersionsTable.bulkPut).toHaveBeenCalled()
    dispose()
  })

  it("syncs comment-store changes to the generalized contextComments table", async () => {
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await Promise.resolve()
    await Promise.resolve()

    commentStore.setState({
      comments: {
        "doc-1": [
          {
            id: "c-1",
            documentId: "doc-1",
            content: "hi",
            createdAt: new Date(1000),
            updatedAt: new Date(1500),
            resolvedAt: undefined,
          },
        ],
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(contextCommentsTable.bulkPut).toHaveBeenCalled()
    dispose()
  })

  it("disposer stops further sync attempts after invocation", async () => {
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    // Wait for the async hydrate-then-subscribe boot order to fully run; the
    // disposer only unsubscribes once `useArtifactStore.subscribe` has been
    // called (after hydration resolves).
    await new Promise((r) => setTimeout(r, 30))

    dispose()
    canvasDocumentsTable.bulkPut.mockClear()

    artifactStore.setState({
      canvasDocuments: {
        "doc-x": {
          id: "doc-x",
          sessionId: "",
          title: "X",
          content: "",
          language: "ts",
          type: "code",
          createdAt: new Date(1),
          updatedAt: new Date(2),
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(canvasDocumentsTable.bulkPut).not.toHaveBeenCalled()
  })

  // The outside-the-browser branch lives in `dexie-bridge.ssr.test.ts` —
  // jsdom's `window` is non-configurable from Node 26 on.

  it("writes only the document that changed, not the whole corpus", async () => {
    // This was the single heaviest per-keystroke cost in the editor: the sync
    // pushed EVERY document and EVERY version unconditionally, which made the
    // early-return unreachable whenever one document existed — so one character
    // ran an IndexedDB transaction over the entire canvas library.
    artifactStore._resetTo({
      canvasDocuments: {
        a: {
          id: "a",
          sessionId: "",
          title: "A",
          content: "a",
          language: "md",
          type: "doc",
          createdAt: new Date(1),
          updatedAt: new Date(1),
          versions: [{ id: "va", content: "a", title: "A", createdAt: new Date(1) }],
        },
        b: {
          id: "b",
          sessionId: "",
          title: "B",
          content: "b",
          language: "md",
          type: "doc",
          createdAt: new Date(1),
          updatedAt: new Date(1),
          versions: [{ id: "vb", content: "b", title: "B", createdAt: new Date(1) }],
        },
      },
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    canvasDocumentsTable.bulkPut.mockClear()
    canvasVersionsTable.bulkPut.mockClear()

    const prev = artifactStore.getState().canvasDocuments
    artifactStore.setState({
      canvasDocuments: { ...prev, b: { ...prev.b, content: "b typed" } },
    })
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    expect(canvasDocumentsTable.bulkPut).toHaveBeenCalledTimes(1)
    expect(canvasDocumentsTable.bulkPut.mock.calls[0][0].map((r) => r.id)).toEqual(["b"])
    // Versions are immutable once written; neither document's needs a rewrite.
    expect(canvasVersionsTable.bulkPut).not.toHaveBeenCalled()
    dispose()
  })

  it("does nothing at all for a store write that touches no canvas document", async () => {
    // The subscription is unselected, so it fires on every artifact-store
    // write — including ones that only touch artifacts.
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))
    canvasDocumentsTable.bulkPut.mockClear()

    artifactStore.setState({ panelOpen: true } as never)
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    expect(canvasDocumentsTable.bulkPut).not.toHaveBeenCalled()
    dispose()
  })

  it("coalesces a burst of edits into one transaction", async () => {
    artifactStore._resetTo({
      canvasDocuments: {
        a: {
          id: "a",
          sessionId: "",
          title: "A",
          content: "",
          language: "md",
          type: "doc",
          createdAt: new Date(1),
          updatedAt: new Date(1),
          versions: [],
        },
      },
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))
    canvasDocumentsTable.bulkPut.mockClear()

    for (let i = 1; i <= 5; i += 1) {
      const prev = artifactStore.getState().canvasDocuments
      artifactStore.setState({
        canvasDocuments: { ...prev, a: { ...prev.a, content: "x".repeat(i) } },
      })
    }
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    expect(canvasDocumentsTable.bulkPut).toHaveBeenCalledTimes(1)
    expect(canvasDocumentsTable.bulkPut.mock.calls[0][0][0].content).toBe("xxxxx")
    dispose()
  })

  it("flushes a pending mirror when the bridge is disposed", async () => {
    artifactStore._resetTo({ canvasDocuments: {} })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))
    canvasDocumentsTable.bulkPut.mockClear()

    artifactStore.setState({
      canvasDocuments: {
        late: {
          id: "late",
          sessionId: "",
          title: "Late",
          content: "x",
          language: "md",
          type: "doc",
          createdAt: new Date(1),
          updatedAt: new Date(1),
          versions: [],
        },
      },
    })
    // No wait: the debounce is still pending. Tearing down must not drop it.
    dispose()
    await Promise.resolve()
    await Promise.resolve()

    expect(canvasDocumentsTable.bulkPut).toHaveBeenCalled()
  })

  it("removes documents from Dexie when artifact-store drops them", async () => {
    // Seed memory with one doc, then start bridge.
    artifactStore._resetTo({
      canvasDocuments: {
        "to-remove": {
          id: "to-remove",
          sessionId: "",
          title: "RM",
          content: "x",
          language: "ts",
          type: "code",
          createdAt: new Date(1),
          updatedAt: new Date(2),
          versions: [{ id: "v-rm", content: "old", title: "RM", createdAt: new Date(1) }],
        },
      },
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    // Drop the doc; the bridge should issue a delete.
    artifactStore.setState({ canvasDocuments: {} })
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))
    // The where().equals().delete() chain on canvasVersions / Comments / Sessions
    // is invoked, plus `canvasDocuments.delete("to-remove")`.
    expect(canvasDocumentsTable.delete).toHaveBeenCalledWith("to-remove")
    dispose()
  })

  it("removes comments from Dexie when comment-store drops them", async () => {
    commentStore._resetTo({
      comments: {
        "doc-c": [
          {
            id: "c-keep",
            documentId: "doc-c",
            content: "k",
            createdAt: new Date(1),
          },
        ],
      },
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))

    commentStore.setState({ comments: {} })
    await new Promise((r) => setTimeout(r, 30))
    expect(contextCommentsTable.bulkDelete).toHaveBeenCalled()
    dispose()
  })

  it("hydrates and merges comments without overwriting in-memory rows", async () => {
    canvasDocumentsTable.records.push({
      id: "doc-hyd",
      sessionId: "s",
      title: "H",
      content: "x",
      language: "ts",
      type: "code",
      createdAt: 1,
      updatedAt: 2,
    })
    contextCommentsTable.records.push({
      id: "c-hyd",
      resourceKind: "canvas-document",
      resourceId: "doc-hyd",
      anchor: {
        kind: "text-range",
        start: 0,
        end: 0,
        lineRange: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      },
      authorId: "user-1",
      authorName: "Maya",
      content: "from-dexie",
      reactions: [],
      createdAt: 100,
      updatedAt: 200,
      resolvedAt: 300,
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))
    const comments = commentStore.getState().comments["doc-hyd"]
    expect(Array.isArray(comments)).toBe(true)
    expect((comments?.[0] as { id?: string } | undefined)?.id).toBe("c-hyd")
    dispose()
  })

  it("logs a warning when hydration throws", async () => {
    // Force the toArray to reject for the first (canvasDocuments) call.
    const originalToArray = canvasDocumentsTable.toArray
    canvasDocumentsTable.toArray = jest.fn(async () => {
      throw new Error("dexie down")
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))
    // Bridge should still attempt subscription setup despite the rejection.
    canvasDocumentsTable.toArray = originalToArray
    dispose()
  })

  it("logs a warning when document sync rejects", async () => {
    fakeDb.transaction = jest.fn(async () => {
      throw new Error("write failed")
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))
    artifactStore.setState({
      canvasDocuments: {
        "doc-broken": {
          id: "doc-broken",
          sessionId: "",
          title: "B",
          content: "",
          language: "ts",
          type: "code",
          createdAt: new Date(1),
          updatedAt: new Date(2),
        },
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    dispose()
  })
  it("carries the fields the mirror used to drop", async () => {
    // `sourceArtifactId` / `returnContext` / `authoringOrigin` / `aiWorkbench`
    // lived only in the localStorage blob until persist v7. Dropping them here
    // was invisible while that blob was authoritative and became a broken
    // "return to the artifact this came from" the moment it stopped being.
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))

    artifactStore.setState({
      canvasDocuments: {
        "doc-origin": {
          id: "doc-origin",
          sessionId: "s_1",
          title: "From an artifact",
          content: "x",
          language: "ts",
          type: "code",
          createdAt: new Date(1),
          updatedAt: new Date(2),
          sourceArtifactId: "art_1",
          authoringOrigin: "artifact-panel",
          returnContext: {
            scope: "session",
            searchQuery: "",
            typeFilter: "all",
            runtimeFilter: "all",
          },
          aiWorkbench: {
            promptDraft: "tighten the intro",
            selectedPresetAction: null,
            attachments: [],
            pendingReview: null,
            actionHistory: [],
            isInlineCommandOpen: false,
          },
        },
      },
    })
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    const row = canvasDocumentsTable.records.find((r) => r.id === "doc-origin")
    expect(row).toMatchObject({
      sourceArtifactId: "art_1",
      authoringOrigin: "artifact-panel",
      returnContext: expect.objectContaining({ scope: "session" }),
      aiWorkbench: expect.objectContaining({ promptDraft: "tighten the intro" }),
    })
    dispose()
  })

  it("routes hydrated rows through the store's rehydrator", async () => {
    // A restored backup hands back ISO strings where the type says Date, and
    // the store is the single place that knows which fields those are.
    canvasDocumentsTable.records.push({
      id: "doc-h",
      sessionId: "s",
      title: "H",
      content: "c",
      language: "ts",
      type: "code",
      createdAt: 1,
      updatedAt: 2,
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))

    expect(rehydrateCanvasDocumentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc-h" })
    )
    dispose()
  })

  it("does not write back the rows hydration just read", async () => {
    canvasDocumentsTable.records.push({
      id: "doc-primed",
      sessionId: "s",
      title: "P",
      content: "c",
      language: "ts",
      type: "code",
      createdAt: 1,
      updatedAt: 2,
    })
    canvasVersionsTable.records.push({
      id: "v-primed",
      documentId: "doc-primed",
      title: "P",
      content: "c",
      createdAt: 1,
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))

    expect(canvasDocumentsTable.bulkPut).not.toHaveBeenCalled()
    expect(canvasVersionsTable.bulkPut).not.toHaveBeenCalled()
    dispose()
  })

  it("refuses to write into a database the mirror was not built against", async () => {
    // Locking an account clears the Dexie selection BEFORE it clears the store,
    // so a live subscription sees an empty store pointed at another database.
    artifactStore._resetTo({
      canvasDocuments: {
        keep: {
          id: "keep",
          sessionId: "s",
          title: "K",
          content: "c",
          language: "ts",
          type: "code",
          createdAt: new Date(1),
          updatedAt: new Date(2),
        },
      },
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))
    expect(canvasDocumentsTable.records).toHaveLength(1)

    fakeDb.name = "cognia-account-acct_b"
    artifactStore.setState({ canvasDocuments: {} })
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    expect(canvasDocumentsTable.records).toHaveLength(1)
    dispose()
  })

  it("disables the mirror when hydration fails instead of deleting the table", async () => {
    // Deletes are derived from "in the mirror, absent from memory". A partial
    // read makes memory an unknown subset, so syncing it deletes the rest.
    canvasDocumentsTable.toArray.mockRejectedValueOnce(new Error("DatabaseClosedError"))
    canvasDocumentsTable.records.push({
      id: "survivor",
      sessionId: "s",
      title: "S",
      content: "c",
      language: "ts",
      type: "code",
      createdAt: 1,
      updatedAt: 2,
    })
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    await new Promise((r) => setTimeout(r, 30))

    artifactStore.setState({ canvasDocuments: {} })
    await new Promise((r) => setTimeout(r, DOCUMENT_SYNC_WAIT_MS))

    expect(canvasDocumentsTable.records.map((r) => r.id)).toEqual(["survivor"])
    dispose()
  })
})
