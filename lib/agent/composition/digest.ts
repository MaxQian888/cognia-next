/**
 * Content digests for a resolved composition (ADR-0117 / ADR-0118).
 *
 * These are content-addressing digests, not the execution *fingerprint*. The
 * two are siblings and are deliberately computed differently:
 *
 *   - `computeExecutionFingerprint` (`lib/ai/agent/execution/fingerprint.ts`)
 *     answers "is this the same execution decision?", so it is synchronous
 *     FNV-1a over a canonicalization that DROPS volatile keys.
 *   - These answer "is this the same content?", so nothing may be dropped and
 *     the hash is SHA-256, matching the `sha256:` prefix the eval asset store
 *     already uses (`lib/ai/eval/assets.ts`) — a prompt digest and an eval
 *     artifact id have to be comparable.
 *
 * Reusing the fingerprint's canonicalizer here would be a real bug, not just a
 * style choice: it strips any key named `timestamp`, `at`, `turnId`, … at every
 * depth, so two different tool schemas — one with a `timestamp` property, one
 * without — would digest identically and silently share a replay tape.
 */

import { canonicalizeJson } from "@/lib/plugin/character-pack/canonical-json"
import { compositionDigestPayload } from "@cognia/agent-config-types/agent-composition"
import type { ResolvedAgentCompositionV1 } from "@cognia/agent-config-types/agent-composition"

/** Hex-encoded SHA-256 of a UTF-8 string. Injectable for tests. */
export type Sha256Hex = (input: string) => Promise<string>

async function webCryptoSha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * SHA-256 over the RFC 8785 canonical form of `value`, prefixed `sha256:`.
 *
 * Canonicalization is shared with Character Pack signing rather than
 * reimplemented, so key order, number formatting and unpaired-surrogate
 * rejection are identical everywhere the repo content-addresses something.
 */
export async function digestValue(
  value: unknown,
  hash: Sha256Hex = webCryptoSha256
): Promise<string> {
  return `sha256:${await hash(canonicalizeJson(value))}`
}

/** Digest of the final system prompt, exactly as it will be sent. */
export function digestPrompt(prompt: string, hash?: Sha256Hex): Promise<string> {
  return digestValue(prompt, hash)
}

/**
 * One entry of the tool surface a model sees.
 *
 * `schema` is included because a renamed parameter changes behaviour just as
 * much as a removed tool, and `visibility` because the same tool offered
 * natively and offered through the code SDK are not the same surface.
 */
export interface ToolSurfaceEntry {
  name: string
  schema: unknown
  visibility: "native" | "code"
}

/**
 * Digest of the ordered tool list.
 *
 * Order is preserved, never sorted: providers are sensitive to tool order, so
 * two runs that offered the same tools in a different order are genuinely
 * different requests and must not collide.
 */
export function digestToolSurface(
  tools: readonly ToolSurfaceEntry[],
  hash?: Sha256Hex
): Promise<string> {
  return digestValue(
    tools.map((tool) => ({ name: tool.name, schema: tool.schema, visibility: tool.visibility })),
    hash
  )
}

/** Digest of the composition itself; see `compositionDigestPayload` for scope. */
export function digestComposition(
  resolved: Parameters<typeof compositionDigestPayload>[0],
  hash?: Sha256Hex
): Promise<string> {
  return digestValue(compositionDigestPayload(resolved), hash)
}

/**
 * Stamp `compositionDigest` onto an otherwise-complete resolution.
 *
 * Split from resolution itself because resolving is synchronous and hashing is
 * not: the resolver can decide the whole composition without awaiting, and only
 * the digest — which nothing in the turn needs before the first model call —
 * is deferred.
 */
export async function withCompositionDigest(
  resolved: Omit<ResolvedAgentCompositionV1, "compositionDigest">,
  hash?: Sha256Hex
): Promise<ResolvedAgentCompositionV1> {
  return { ...resolved, compositionDigest: await digestComposition(resolved, hash) }
}
