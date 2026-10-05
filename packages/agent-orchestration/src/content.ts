/**
 * Content-addressed blobs a run's trajectory and evidence point at
 * (ADR-0217). The hash is the identity, so the same bytes stored twice are one
 * object.
 */

import type { AgentTeamContentObject } from "./records"

/** The `sha256:<hex>` address of `data`. */
export async function contentHash(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for AgentTeam content")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource)
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

/** Build the content object for `content`, addressed by its SHA-256. */
export async function createContentObject(
  content: string | Uint8Array,
  mimeType: string,
  createdAt: number
): Promise<AgentTeamContentObject> {
  const data =
    typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content)
  return {
    hash: await contentHash(data),
    mimeType,
    byteLength: data.byteLength,
    data,
    createdAt,
  }
}
