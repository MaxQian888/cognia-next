/**
 * What a Canvas share link is allowed to carry.
 *
 * Three identifiers, and nothing else: which organisation, which workspace,
 * which document. Everything the joiner needs beyond that is looked up on their
 * side, under their own identity, against their own membership.
 *
 * The old link carried two things it must not:
 *
 * - **The session itself**, as JSON: the session id, the owner, the participant
 *   list, the permission flags, the document content and its whole operation
 *   log. Permissions in a link are permissions the recipient can edit, and the
 *   payload went straight into an unvalidated `JSON.parse` sink that installed
 *   whatever session it described.
 * - **A server URL**, as `?server=`, which the join page wrote into persisted
 *   settings with `enabled: true` and no validation of scheme or host at all.
 *   One click pointed a user's collaboration transport at an arbitrary machine.
 *
 * The two halves also disagreed: the panel emitted raw JSON while the page
 * `atob`ed it, so every link this app produced failed to decode.
 */

/** The identifiers a share link carries. */
export interface CanvasShareTarget {
  orgId: string
  workspaceId: string
  documentId: string
}

/** Why a link could not be read. */
export type CanvasShareLinkError = "missing" | "malformed"

export type CanvasShareLinkResult =
  { ok: true; target: CanvasShareTarget } | { ok: false; error: CanvasShareLinkError }

/**
 * Ids are opaque to this module, but they end up in URLs, in log lines and in
 * request paths, so the shape is checked rather than assumed. Anything outside
 * this alphabet is a malformed link, not a lookup that will fail later.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function isId(value: string | null | undefined): value is string {
  return typeof value === "string" && ID_PATTERN.test(value)
}

/**
 * The path a share link points at.
 *
 * Relative on purpose: the origin is wherever the app already is, so a link
 * cannot redirect the recipient's client to a different deployment.
 */
export function buildCanvasSharePath(target: CanvasShareTarget): string {
  const params = new URLSearchParams({
    org: target.orgId,
    workspace: target.workspaceId,
    document: target.documentId,
  })
  return `/canvas/join?${params.toString()}`
}

/** Read a share target out of a query string. */
export function parseCanvasShareLink(
  params: Pick<URLSearchParams, "get"> | null | undefined
): CanvasShareLinkResult {
  const orgId = params?.get("org") ?? null
  const workspaceId = params?.get("workspace") ?? null
  const documentId = params?.get("document") ?? null

  if (!orgId && !workspaceId && !documentId) {
    return { ok: false, error: "missing" }
  }
  if (!isId(orgId) || !isId(workspaceId) || !isId(documentId)) {
    return { ok: false, error: "malformed" }
  }
  return { ok: true, target: { orgId, workspaceId, documentId } }
}

/**
 * Whether a link is one of the old ones.
 *
 * Those cannot be honoured: they name a session id from another device's
 * in-memory store and a server this client must not trust. The joiner is told
 * the link is expired and to ask for a new one, which is true and actionable,
 * rather than being shown a decode failure.
 */
export function isLegacyCanvasShareLink(
  params: Pick<URLSearchParams, "get"> | null | undefined
): boolean {
  return Boolean(params?.get("session") || params?.get("server"))
}
