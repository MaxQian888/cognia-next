"use client"

/**
 * Where a Canvas document lives on the collaboration plane, and how to open a
 * socket to it.
 *
 * # What this replaced
 *
 * Two placeholders that between them made remote Canvas unreachable.
 *
 * The transport pointed at a hard-coded `ws://localhost:8080/canvas`, a route
 * no server has ever served, and it would only open with a
 * `remoteAuthorization` that nothing in the app minted. The honest description
 * was "fails closed", but the effect was that the whole remote half was dead.
 *
 * Share links named an org called `"personal"`, invented because there was no
 * synchronous accessor for the real one. A recipient is checked against org
 * AND workspace membership, so a link naming a fictional org could never be
 * honoured by a real server.
 *
 * Both are answered by the same three facts: the org comes from the sign-in
 * binding, the workspace from the document's own `projectId`, and the socket
 * from `CollabClient.openCanvasStream`, which mints a fresh single-use ticket
 * per call and goes through the proxy-aware platform transport.
 *
 * # Null is the normal answer
 *
 * A machine with no collaboration server configured, a profile nobody has
 * signed in on, or a document not filed under a workspace all return `null`.
 * None of those is an error: Canvas is local-first, and the local document
 * keeps working. Collaboration is the thing that needs a network.
 */

import { resolveCurrentCollabContext } from "@/lib/collab/runtime-client"
import type { CollabCanvasDocument, CollabCanvasUpdate, CollabClient } from "@/lib/collab/client"
import { CollabError } from "@/lib/collab/client"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { CanvasSocketFactory } from "./websocket-provider"
import type { CanvasShareTarget } from "./share-link"
import {
  canvasSeedOperationId,
  encodeSeedUpdate,
  type CanvasCRDTStore,
  type CRDTOperation,
} from "./crdt-store"
import { loggers } from "@cognia/logging"

const log = loggers.canvas

/** One document's address on the plane, plus the way in. */
export interface CanvasTransportBinding {
  orgId: string
  workspaceId: string
  documentId: string
  /** The server-owned person id, which is who the plane attributes edits to. */
  userId: string
  client: CollabClient
  openSocket: CanvasSocketFactory
}

export interface CanvasTransportDeps {
  resolveContext?: typeof resolveCurrentCollabContext
  /** The document's workspace, when the caller already knows it. */
  readWorkspaceId?: (documentId: string) => string | null
}

function defaultWorkspaceId(documentId: string): string | null {
  return useArtifactStore.getState().getCanvasDocumentForWorkspace(documentId)?.projectId ?? null
}

/**
 * Resolve the transport for one document, or `null` when there is none.
 *
 * Deliberately does not create anything server-side. Opening a socket is a
 * separate, explicit act, so simply having Canvas open does not publish every
 * local document to an org.
 */
export async function resolveCanvasTransport(
  documentId: string,
  deps: CanvasTransportDeps = {}
): Promise<CanvasTransportBinding | null> {
  const workspaceId = (deps.readWorkspaceId ?? defaultWorkspaceId)(documentId)
  // A document filed under no workspace cannot be addressed: membership is
  // resolved per workspace, and there would be nothing to resolve against.
  if (!workspaceId) return null

  const context = await (deps.resolveContext ?? resolveCurrentCollabContext)()
  if (!context) return null

  return {
    orgId: context.orgId,
    workspaceId,
    documentId,
    userId: context.userId,
    client: context.client,
    openSocket: (handlers) => context.client.openCanvasStream(context.orgId, documentId, handlers),
  }
}

/**
 * The identifiers a share link carries, from the real org rather than a
 * placeholder. `null` when this install has no plane to share onto.
 */
export async function resolveCanvasShareTarget(
  documentId: string,
  deps: CanvasTransportDeps = {}
): Promise<CanvasShareTarget | null> {
  const binding = await resolveCanvasTransport(documentId, deps)
  if (!binding) return null
  return {
    orgId: binding.orgId,
    workspaceId: binding.workspaceId,
    documentId: binding.documentId,
  }
}

/**
 * Make sure the plane holds a row for this document, and return it.
 *
 * Read first, create on 404. Creating blind would be simpler, but the create
 * route is idempotent on `operationId` rather than on the document id, so a
 * document that already exists under a different operation id would collide on
 * the primary key instead of resolving to the row that is already there.
 *
 * `null` means the caller may not publish here, which a viewer cannot. That is
 * not an error either: they can still read the document once somebody with
 * write access has published it.
 */
export async function publishCanvasDocument(
  binding: CanvasTransportBinding,
  document: { title: string; language: string }
): Promise<CollabCanvasDocument | null> {
  try {
    return await binding.client.getCanvasDocument(binding.orgId, binding.documentId)
  } catch (error) {
    if (!(error instanceof CollabError) || error.status !== 404) throw error
  }
  try {
    return await binding.client.createCanvasDocument(binding.orgId, binding.workspaceId, {
      id: binding.documentId,
      title: document.title,
      language: document.language,
      // Stable, so a retry after a network failure resolves to the row the
      // first attempt created rather than failing on the primary key.
      operationId: `canvas-create:${binding.documentId}`,
    })
  } catch (error) {
    if (error instanceof CollabError && (error.status === 403 || error.status === 404)) {
      log.info("canvas document not published: no write access", {
        documentId: binding.documentId,
        status: error.status,
      })
      return null
    }
    throw error
  }
}

/**
 * A server that keeps answering `hasMore` without moving forward would
 * otherwise keep a catch-up looping for ever.
 */
const MAX_CATCH_UP_PAGES = 1_000

export interface CanvasCatchUpResult {
  /** The highest server sequence the document now holds. */
  latestSequence: number
  /** Whether the plane holds nothing at all for this document. */
  empty: boolean
}

function operationFromRecord(record: CollabCanvasUpdate): CRDTOperation {
  return {
    id: record.operationId,
    update: record.payload,
    origin: `plane:${record.authorUserId}`,
    timestamp: record.createdAt,
  }
}

/**
 * Apply everything the plane holds after `since`, page by page.
 *
 * The socket used to be asked instead, and it answers with one page and no
 * way to ask for the next, so a document with more history than a page was
 * silently cut short for everybody who joined it. The HTTP route says
 * `hasMore`, and this keeps going until it stops saying so.
 *
 * Everything is applied under the remote origin, so none of it is sent back.
 */
export async function catchUpCanvasDocument(
  binding: CanvasTransportBinding,
  store: CanvasCRDTStore,
  sessionId: string,
  since = 0
): Promise<CanvasCatchUpResult> {
  let cursor = Math.max(0, since)
  let empty = true
  for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
    const caughtUp = await binding.client.pullCanvasUpdates(
      binding.orgId,
      binding.documentId,
      cursor
    )
    const before = cursor
    if (caughtUp.latestSequence > 0 || caughtUp.snapshot) empty = false
    if (caughtUp.snapshot) {
      if (!store.applySnapshot(sessionId, caughtUp.snapshot)) {
        throw new Error("The collaboration server sent a snapshot this document cannot apply")
      }
      cursor = Math.max(cursor, caughtUp.snapshotSequence)
    }
    for (const update of caughtUp.updates) {
      store.applyRemoteUpdate(sessionId, operationFromRecord(update))
      cursor = Math.max(cursor, update.sequence)
    }
    if (!caughtUp.hasMore) return { latestSequence: cursor, empty }
    if (cursor === before) {
      throw new Error("The collaboration server reported more updates without advancing")
    }
  }
  throw new Error("Canvas catch-up did not reach the end of the document's history")
}

/** Raised when the plane holds nothing for a document and this user may not seed it. */
export class CanvasSeedForbiddenError extends Error {
  constructor() {
    super("This document is empty on the collaboration server and you cannot write to it")
    this.name = "CanvasSeedForbiddenError"
  }
}

export type CanvasHydration =
  /** The plane already held the document; this device took its state. */
  | { kind: "joined"; latestSequence: number }
  /** The plane was empty and now holds a baseline, this device's or a racer's. */
  | { kind: "seeded"; latestSequence: number; seededHere: boolean }
  /** The plane and the local copy are both empty. Nothing to publish. */
  | { kind: "empty"; latestSequence: number }

/**
 * Bring a pending session's empty document up to the plane's state.
 *
 * The plane is the authority on what the shared text is. A device only
 * contributes its local copy when the plane holds nothing, and even then it
 * publishes under `canvasSeedOperationId`, so two devices racing to seed the
 * same document end up on one baseline instead of each inserting its own copy
 * of the text: the server keeps the first and hands it to the second.
 *
 * `readLocalContent` is read after the plane has answered rather than when
 * the session opened, so what somebody typed while the connection was coming
 * up is part of what gets published.
 */
export async function hydrateCanvasSession(
  binding: CanvasTransportBinding,
  store: CanvasCRDTStore,
  sessionId: string,
  readLocalContent: () => string
): Promise<CanvasHydration> {
  const initial = await catchUpCanvasDocument(binding, store, sessionId, 0)
  if (!initial.empty) return { kind: "joined", latestSequence: initial.latestSequence }

  const content = readLocalContent()
  if (content.length === 0) return { kind: "empty", latestSequence: initial.latestSequence }

  const update = encodeSeedUpdate(content)
  let record: CollabCanvasUpdate
  try {
    record = await binding.client.pushCanvasUpdate(binding.orgId, binding.documentId, {
      update,
      operationId: canvasSeedOperationId(binding.documentId),
    })
  } catch (error) {
    if (error instanceof CollabError && error.status === 403) throw new CanvasSeedForbiddenError()
    throw error
  }
  store.applyRemoteUpdate(sessionId, operationFromRecord(record))
  // Somebody may have seeded first and kept typing. Their later updates are
  // after the seed's sequence, not before it.
  const after = await catchUpCanvasDocument(binding, store, sessionId, record.sequence)
  return {
    kind: "seeded",
    latestSequence: Math.max(record.sequence, after.latestSequence),
    seededHere: record.payload === update,
  }
}
