/**
 * @jest-environment jsdom
 */

import {
  publishCanvasDocument,
  resolveCanvasShareTarget,
  resolveCanvasTransport,
  type CanvasTransportBinding,
} from "./canvas-transport"
import { CollabError } from "@/lib/collab/client"

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
