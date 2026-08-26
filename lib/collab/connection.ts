"use client"

/**
 * Where the app remembers *which* collaboration server it talks to.
 *
 * # Why this had to exist before anything else in Batch 7
 *
 * `CollabClient`, `pullCollabIssues`, the `collabIssues` mirror and the board
 * source all landed in Batch 3, and none of them had a production caller —
 * because nothing told them where the server was. A plane nobody can point at
 * is the repo's most recurrent defect class in its purest form: built,
 * correct, tested, unreachable.
 *
 * # What is and is not stored
 *
 * Only the URL. Unlike `lib/diagnostic-service/connection.ts` there is no
 * secret half to keep out of it: the credential is the Logto session, which
 * already lives in the OS keyring, and the org comes from the sign-in binding
 * rather than from operator input — asking somebody to type their own org id
 * is asking them to get it wrong.
 *
 * Account-scoped, because a machine can hold several local profiles (ADR-0054)
 * and they may legitimately belong to different orgs on different servers.
 */

import { normalizeServiceUrl } from "@/lib/diagnostic-service/client"

const CONNECTION_KEY_PREFIX = "cognia.collab.connection"

export interface CollabConnection {
  /** Normalized service origin, path prefix preserved. */
  baseUrl: string
}

/** Storage seam so tests need no `localStorage`. */
export interface CollabConnectionDeps {
  local?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

function connectionKey(localAccountId: string): string {
  return `${CONNECTION_KEY_PREFIX}.${localAccountId}`
}

function store(deps: CollabConnectionDeps): CollabConnectionDeps["local"] | null {
  if (deps.local) return deps.local
  if (typeof localStorage === "undefined") return null
  return localStorage
}

/**
 * Read the stored connection, or `null` when there is none.
 *
 * A record that no longer parses is removed rather than returned: a half-valid
 * connection renders a configured-looking panel that fails on first use, which
 * is the harder failure to diagnose.
 */
export function loadCollabConnection(
  localAccountId: string,
  deps: CollabConnectionDeps = {}
): CollabConnection | null {
  const local = store(deps)
  if (!local) return null
  const raw = local.getItem(connectionKey(localAccountId))
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object")
    const candidate = parsed as { baseUrl?: unknown }
    if (typeof candidate.baseUrl !== "string" || !candidate.baseUrl) {
      throw new Error("no base url")
    }
    return { baseUrl: normalizeServiceUrl(candidate.baseUrl) }
  } catch {
    local.removeItem(connectionKey(localAccountId))
    return null
  }
}

export function saveCollabConnection(
  localAccountId: string,
  connection: CollabConnection,
  deps: CollabConnectionDeps = {}
): CollabConnection {
  const normalized: CollabConnection = { baseUrl: normalizeServiceUrl(connection.baseUrl) }
  store(deps)?.setItem(connectionKey(localAccountId), JSON.stringify(normalized))
  return normalized
}

/**
 * Forget the connection.
 *
 * Deliberately does NOT clear the mirror: the rows are a cache of what the
 * server said while it was reachable, and wiping them on a configuration
 * change would make "I mistyped the URL" indistinguishable from "everything
 * was deleted". `clearCollabIssues` is a separate, explicit act.
 */
export function forgetCollabConnection(
  localAccountId: string,
  deps: CollabConnectionDeps = {}
): void {
  store(deps)?.removeItem(connectionKey(localAccountId))
}
