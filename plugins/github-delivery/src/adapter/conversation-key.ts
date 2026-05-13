/**
 * Shared encode / decode for the GitHub Delivery conversation key. Both
 * inbound (inbox-bridge.ts) and outbound (github-adapter.ts) sides resolve
 * `(owner, repo, kind, number)` through this single helper so threads in
 * the Inbox and replies from the composer stay aligned.
 *
 * The format is determined by `lib/connectors/event.buildConversationKey`:
 *   platform:adapterId:remoteChatId
 * with our remoteChatId being `<owner>/<repo>#<kind>-<number>`.
 */

import { buildConversationKey, parseConversationKey } from "@/types/connectors/event"

export const GITHUB_ADAPTER_ID = "github-delivery"

export type GhConversationKind = "pr" | "issue"

export interface GhConversationCoords {
  owner: string
  repo: string
  kind: GhConversationKind
  number: number
}

/** Build the `<owner>/<repo>#<kind>-<n>` slice used by the inbox bridge. */
export function buildRemoteChatId(coords: GhConversationCoords): string {
  return `${coords.owner}/${coords.repo}#${coords.kind}-${coords.number}`
}

/**
 * Encode a fully-qualified conversation key the bus uses to dedupe events
 * and route outbound sends.
 */
export function encodeConversationKey(coords: GhConversationCoords): string {
  return buildConversationKey("github", GITHUB_ADAPTER_ID, buildRemoteChatId(coords))
}

/**
 * Parse a conversation key emitted by `encodeConversationKey`. Returns
 * `null` for keys that don't match the github shape — callers can fall
 * back to their previous behaviour without `try / catch`.
 */
export function decodeConversationKey(key: string): GhConversationCoords | null {
  let parsed
  try {
    parsed = parseConversationKey(key)
  } catch {
    return null
  }
  if (parsed.platform !== "github" || parsed.adapterId !== GITHUB_ADAPTER_ID) {
    return null
  }
  return parseRemoteChatId(parsed.remoteChatId)
}

/**
 * Parse the `<owner>/<repo>#<kind>-<n>` form. Returns `null` for shapes
 * the inbox-bridge can't produce (e.g., repo-only keys). Exported so the
 * inbox-bridge can swap to the helper without duplicating the regex.
 */
export function parseRemoteChatId(remoteChatId: string): GhConversationCoords | null {
  const hashAt = remoteChatId.indexOf("#")
  if (hashAt <= 0 || hashAt === remoteChatId.length - 1) return null
  const repoPart = remoteChatId.slice(0, hashAt)
  const refPart = remoteChatId.slice(hashAt + 1)
  const slashAt = repoPart.indexOf("/")
  if (slashAt <= 0 || slashAt === repoPart.length - 1) return null
  const owner = repoPart.slice(0, slashAt)
  const repo = repoPart.slice(slashAt + 1)
  const dashAt = refPart.indexOf("-")
  if (dashAt <= 0 || dashAt === refPart.length - 1) return null
  const kindStr = refPart.slice(0, dashAt)
  const numStr = refPart.slice(dashAt + 1)
  if (kindStr !== "pr" && kindStr !== "issue") return null
  const number = parseInt(numStr, 10)
  if (!Number.isFinite(number) || number <= 0) return null
  return { owner, repo, kind: kindStr, number }
}
