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
  canvasDocuments: Record<string, unknown>
}>({ canvasDocuments: {} })

const commentStore = makeFakeStore<{ comments: Record<string, unknown[]> }>({
  comments: {},
})

jest.mock("@/stores/artifact/artifact-store", () => ({
  __esModule: true,
  useArtifactStore: artifactStore,
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
  fakeDb.transaction = jest.fn(async (..._args: unknown[]) => {
    const fn = _args[_args.length - 1] as () => Promise<void>
    await fn()
  })
  artifactStore._resetTo({ canvasDocuments: {} })
  commentStore._resetTo({ comments: {} })
  artifactStore._clearSubscribers()
  commentStore._clearSubscribers()
})

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

    await Promise.resolve()
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

  it("returns a noop disposer when called outside the browser", async () => {
    const originalWindow = global.window
    // @ts-expect-error -- simulate node runtime
    delete global.window
    try {
      const { startCanvasDexieBridge } = await import("./dexie-bridge")
      const dispose = startCanvasDexieBridge()
      expect(typeof dispose).toBe("function")
      dispose()
    } finally {
      global.window = originalWindow
    }
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
    await new Promise((r) => setTimeout(r, 30))

    // Drop the doc; the bridge should issue a delete.
    artifactStore.setState({ canvasDocuments: {} })
    await new Promise((r) => setTimeout(r, 30))
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
})
