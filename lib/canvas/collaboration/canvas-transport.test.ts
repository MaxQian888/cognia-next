/**
 * @jest-environment jsdom
 */

import {
  CanvasSeedForbiddenError,
  catchUpCanvasDocument,
  hydrateCanvasSession,
  publishCanvasDocument,
  resolveCanvasShareTarget,
  resolveCanvasTransport,
  type CanvasTransportBinding,
} from "./canvas-transport"
import {
  CanvasCRDTStore,
  canvasSeedOperationId,
  encodeSeedUpdate,
  type CRDTOperation,
} from "./crdt-store"
import { CollabError, type CollabCanvasUpdate } from "@/lib/collab/client"

const artifactDocument: { current: { id: string; projectId?: string } | null } = {
  current: { id: "doc-1", projectId: "ws-1" },
}

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: () => ({
      getCanvasDocumentForWorkspace: (id: string) =>
        artifactDocument.current?.id === id ? artifactDocument.current : null,
    }),
  },
}))

const openCanvasStream = jest.fn()

function context(overrides: Record<string, unknown> = {}) {
  return {
    localAccountId: "acct-1",
    orgId: "org_acme",
    userId: "usr_ada",
    client: { openCanvasStream } as never,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  artifactDocument.current = { id: "doc-1", projectId: "ws-1" }
})

describe("resolveCanvasTransport", () => {
  it("addresses the document by the real org and its own workspace", async () => {
    const binding = await resolveCanvasTransport("doc-1", {
      resolveContext: async () => context(),
    })
    expect(binding).toMatchObject({
      orgId: "org_acme",
      workspaceId: "ws-1",
      documentId: "doc-1",
      userId: "usr_ada",
    })
  })

  it("returns null when this install has no collaboration server", async () => {
    // The ordinary answer for a single-machine user, and not an error: the
    // local document keeps working.
    const binding = await resolveCanvasTransport("doc-1", {
      resolveContext: async () => null,
    })
    expect(binding).toBeNull()
  })

  it("refuses a document that belongs to no workspace", async () => {
    // Membership is resolved per workspace, so there would be nothing to
    // resolve the recipient against.
    artifactDocument.current = { id: "doc-1", projectId: undefined }
    const resolveContext = jest.fn(async () => context())
    const binding = await resolveCanvasTransport("doc-1", { resolveContext })
    expect(binding).toBeNull()
    expect(resolveContext).not.toHaveBeenCalled()
  })

  it("mints a socket through the shared client rather than a bare WebSocket", async () => {
    // A bare `WebSocket` in the renderer misses the desktop proxy settings,
    // and this is also what re-mints the single-use ticket per attempt.
    const binding = await resolveCanvasTransport("doc-1", {
      resolveContext: async () => context(),
    })
    const handlers = { onMessage: jest.fn() }
    await binding!.openSocket(handlers)
    expect(openCanvasStream).toHaveBeenCalledWith("org_acme", "doc-1", handlers)
  })

  it("calls the socket factory afresh for every attempt", async () => {
    const binding = await resolveCanvasTransport("doc-1", {
      resolveContext: async () => context(),
    })
    await binding!.openSocket({})
    await binding!.openSocket({})
    expect(openCanvasStream).toHaveBeenCalledTimes(2)
  })
})

describe("resolveCanvasShareTarget", () => {
  it("carries three identifiers, and the org is the real one", async () => {
    // It used to be the literal string "personal", invented because there was
    // no accessor for the real org. No server could ever have honoured it.
    const target = await resolveCanvasShareTarget("doc-1", {
      resolveContext: async () => context(),
    })
    expect(target).toEqual({ orgId: "org_acme", workspaceId: "ws-1", documentId: "doc-1" })
  })

  it("is null when there is nothing to share onto", async () => {
    await expect(
      resolveCanvasShareTarget("doc-1", { resolveContext: async () => null })
    ).resolves.toBeNull()
  })
})

describe("publishCanvasDocument", () => {
  function binding(client: Record<string, unknown>): CanvasTransportBinding {
    return {
      orgId: "org_acme",
      workspaceId: "ws-1",
      documentId: "doc-1",
      userId: "usr_ada",
      client: client as never,
      openSocket: jest.fn(),
    }
  }

  const document = { title: "Notes", language: "markdown" }

  it("returns the existing row without creating a second one", async () => {
    const getCanvasDocument = jest.fn().mockResolvedValue({ id: "doc-1" })
    const createCanvasDocument = jest.fn()
    const published = await publishCanvasDocument(
      binding({ getCanvasDocument, createCanvasDocument }),
      document
    )
    expect(published).toEqual({ id: "doc-1" })
    expect(createCanvasDocument).not.toHaveBeenCalled()
  })

  it("creates the row when the plane does not have it yet", async () => {
    const getCanvasDocument = jest.fn().mockRejectedValue(new CollabError(404, "not found"))
    const createCanvasDocument = jest.fn().mockResolvedValue({ id: "doc-1" })
    await publishCanvasDocument(binding({ getCanvasDocument, createCanvasDocument }), document)
    expect(createCanvasDocument).toHaveBeenCalledWith(
      "org_acme",
      "ws-1",
      expect.objectContaining({ id: "doc-1", title: "Notes", language: "markdown" })
    )
  })

  it("uses an operation id derived from the document, so a retry is not a second row", async () => {
    const getCanvasDocument = jest.fn().mockRejectedValue(new CollabError(404, "not found"))
    const createCanvasDocument = jest.fn().mockResolvedValue({ id: "doc-1" })
    const target = binding({ getCanvasDocument, createCanvasDocument })
    await publishCanvasDocument(target, document)
    await publishCanvasDocument(target, document)
    const [first, second] = createCanvasDocument.mock.calls
    expect(first[2].operationId).toBe(second[2].operationId)
  })

  it("returns null rather than throwing when the caller may not publish", async () => {
    // A viewer. They can still read the document once somebody with write
    // access has published it, so this is not a failure worth surfacing.
    const getCanvasDocument = jest.fn().mockRejectedValue(new CollabError(404, "not found"))
    const createCanvasDocument = jest.fn().mockRejectedValue(new CollabError(403, "forbidden"))
    await expect(
      publishCanvasDocument(binding({ getCanvasDocument, createCanvasDocument }), document)
    ).resolves.toBeNull()
  })

  it("lets a real failure through instead of reporting a silent no-op", async () => {
    const getCanvasDocument = jest.fn().mockRejectedValue(new CollabError(500, "boom"))
    await expect(
      publishCanvasDocument(binding({ getCanvasDocument }), document)
    ).rejects.toBeInstanceOf(CollabError)
  })
})

/**
 * A plane that keeps an ordered update log, pages it, and deduplicates by
 * operation id the way `canvas_document_updates` does.
 */
function fakePlane(pageSize = 2) {
  const log: CollabCanvasUpdate[] = []
  let snapshot: { payload: string; sequence: number } | null = null
  const pulls: number[] = []
  const client = {
    pullCanvasUpdates: jest.fn(async (_org: string, _doc: string, since = 0) => {
      pulls.push(since)
      const floor = snapshot && since < snapshot.sequence ? snapshot.sequence : since
      const rows = log.filter((row) => row.sequence > floor).slice(0, pageSize)
      const latestSequence =
        log.length > 0 ? log[log.length - 1].sequence : (snapshot?.sequence ?? 0)
      return {
        snapshot: snapshot && since < snapshot.sequence ? snapshot.payload : null,
        snapshotSequence: snapshot?.sequence ?? 0,
        updates: rows,
        latestSequence,
        hasMore: rows.length > 0 && rows[rows.length - 1].sequence < latestSequence,
      }
    }),
    pushCanvasUpdate: jest.fn(
      async (_org: string, documentId: string, input: { update: string; operationId: string }) => {
        const existing = log.find((row) => row.operationId === input.operationId)
        if (existing) return existing
        const sequence = (log[log.length - 1]?.sequence ?? snapshot?.sequence ?? 0) + 1
        const row: CollabCanvasUpdate = {
          documentId,
          sequence,
          payload: input.update,
          authorUserId: "usr_ada",
          createdAt: sequence,
          operationId: input.operationId,
        }
        log.push(row)
        return row
      }
    ),
  }
  return {
    client,
    log,
    pulls,
    compact(payload: string, sequence: number) {
      snapshot = { payload, sequence }
      log.splice(0, log.length, ...log.filter((row) => row.sequence > sequence))
    },
  }
}

function bindingFor(client: unknown): CanvasTransportBinding {
  return {
    orgId: "org_acme",
    workspaceId: "ws-1",
    documentId: "doc-1",
    userId: "usr_ada",
    client: client as never,
    openSocket: jest.fn(),
  }
}

describe("catching up from the plane", () => {
  const sessions: Array<[CanvasCRDTStore, string]> = []
  function device() {
    const store = new CanvasCRDTStore()
    const session = store.createSession("doc-1", "", { pending: true })
    sessions.push([store, session.id])
    return { store, sessionId: session.id }
  }
  afterEach(() => {
    for (const [store, sessionId] of sessions.splice(0)) store.closeSession(sessionId)
  })

  function pushText(plane: ReturnType<typeof fakePlane>, text: string, operationId: string) {
    return plane.client.pushCanvasUpdate("org_acme", "doc-1", {
      update: encodeSeedUpdate(text),
      operationId,
    })
  }

  it("keeps paging until the plane says there is nothing more", async () => {
    // One page used to be the whole answer, which cut a long document short.
    const plane = fakePlane(2)
    const writer = device()
    const ops: string[] = []
    writer.store.onLocalUpdate(writer.sessionId, (op) => ops.push(op.update))
    for (const piece of ["a", "b", "c", "d", "e"]) {
      writer.store.applyLocalUpdate(writer.sessionId, {
        type: "insert",
        position: writer.store.getDocumentContent(writer.sessionId)!.length,
        text: piece,
        origin: "w",
      })
    }
    for (const [index, update] of ops.entries()) {
      await plane.client.pushCanvasUpdate("org_acme", "doc-1", {
        update,
        operationId: `op-${index}`,
      })
    }

    const reader = device()
    const result = await catchUpCanvasDocument(
      bindingFor(plane.client),
      reader.store,
      reader.sessionId,
      0
    )
    expect(reader.store.getDocumentContent(reader.sessionId)).toBe("abcde")
    expect(result).toEqual({ latestSequence: 5, empty: false })
    expect(plane.pulls).toEqual([0, 2, 4])
  })

  it("starts from the stored snapshot when the caller is behind it", async () => {
    const plane = fakePlane(10)
    await pushText(plane, "old", "op-old")
    plane.compact(encodeSeedUpdate("compacted"), 1)
    const reader = device()
    const result = await catchUpCanvasDocument(
      bindingFor(plane.client),
      reader.store,
      reader.sessionId
    )
    expect(reader.store.getDocumentContent(reader.sessionId)).toBe("compacted")
    expect(result).toEqual({ latestSequence: 1, empty: false })
  })

  it("reports an empty plane as empty", async () => {
    const plane = fakePlane()
    const reader = device()
    await expect(
      catchUpCanvasDocument(bindingFor(plane.client), reader.store, reader.sessionId)
    ).resolves.toEqual({ latestSequence: 0, empty: true })
  })

  it("refuses a plane that claims more without moving forward", async () => {
    const reader = device()
    const client = {
      pullCanvasUpdates: jest.fn(async () => ({
        snapshot: null,
        snapshotSequence: 0,
        updates: [],
        latestSequence: 4,
        hasMore: true,
      })),
    }
    await expect(
      catchUpCanvasDocument(bindingFor(client), reader.store, reader.sessionId)
    ).rejects.toThrow(/without advancing/)
  })

  describe("hydrateCanvasSession", () => {
    it("takes the plane's state and publishes nothing when the plane already has the document", async () => {
      const plane = fakePlane()
      await pushText(plane, "shared", "op-1")
      const reader = device()
      const hydration = await hydrateCanvasSession(
        bindingFor(plane.client),
        reader.store,
        reader.sessionId,
        () => "my local copy"
      )
      expect(hydration).toEqual({ kind: "joined", latestSequence: 1 })
      expect(reader.store.getDocumentContent(reader.sessionId)).toBe("shared")
      expect(plane.client.pushCanvasUpdate).toHaveBeenCalledTimes(1)
    })

    it("seeds an empty plane with the local copy under the document's seed id", async () => {
      const plane = fakePlane()
      const first = device()
      const hydration = await hydrateCanvasSession(
        bindingFor(plane.client),
        first.store,
        first.sessionId,
        () => "hello"
      )
      expect(hydration).toEqual({ kind: "seeded", latestSequence: 1, seededHere: true })
      expect(plane.log[0].operationId).toBe(canvasSeedOperationId("doc-1"))
      expect(first.store.getDocumentContent(first.sessionId)).toBe("hello")
    })

    it("puts two racing devices on one baseline instead of two copies of the text", async () => {
      const plane = fakePlane()
      const a = device()
      const b = device()
      const [onA, onB] = await Promise.all([
        hydrateCanvasSession(bindingFor(plane.client), a.store, a.sessionId, () => "from A"),
        hydrateCanvasSession(bindingFor(plane.client), b.store, b.sessionId, () => "from B"),
      ])
      expect(plane.log).toHaveLength(1)
      expect(a.store.getDocumentContent(a.sessionId)).toBe(b.store.getDocumentContent(b.sessionId))
      expect([onA, onB].filter((h) => h.kind === "seeded" && h.seededHere)).toHaveLength(1)

      // And edits on the shared baseline apply on the other side.
      const edits: CRDTOperation[] = []
      a.store.onLocalUpdate(a.sessionId, (op) => edits.push(op))
      a.store.applyLocalUpdate(a.sessionId, { type: "insert", position: 0, text: ">", origin: "a" })
      b.store.applyRemoteUpdate(b.sessionId, edits[0])
      expect(b.store.getDocumentContent(b.sessionId)).toBe(a.store.getDocumentContent(a.sessionId))
    })

    it("reads the local copy only after the plane has answered", async () => {
      const plane = fakePlane()
      const reader = device()
      const readLocal = jest.fn(() => "typed while connecting")
      await hydrateCanvasSession(
        bindingFor(plane.client),
        reader.store,
        reader.sessionId,
        readLocal
      )
      expect(readLocal.mock.invocationCallOrder[0]).toBeGreaterThan(
        plane.client.pullCanvasUpdates.mock.invocationCallOrder[0]
      )
      expect(reader.store.getDocumentContent(reader.sessionId)).toBe("typed while connecting")
    })

    it("publishes nothing when both copies are empty", async () => {
      const plane = fakePlane()
      const reader = device()
      await expect(
        hydrateCanvasSession(bindingFor(plane.client), reader.store, reader.sessionId, () => "")
      ).resolves.toEqual({ kind: "empty", latestSequence: 0 })
      expect(plane.client.pushCanvasUpdate).not.toHaveBeenCalled()
    })

    it("fails clearly when the plane is empty and this user may not write", async () => {
      const reader = device()
      const client = {
        pullCanvasUpdates: jest.fn(async () => ({
          snapshot: null,
          snapshotSequence: 0,
          updates: [],
          latestSequence: 0,
          hasMore: false,
        })),
        pushCanvasUpdate: jest.fn(async () => {
          throw new CollabError(403, "forbidden")
        }),
      }
      await expect(
        hydrateCanvasSession(bindingFor(client), reader.store, reader.sessionId, () => "text")
      ).rejects.toBeInstanceOf(CanvasSeedForbiddenError)
    })
  })
})
