// OpenCode-specific TS-only types. The underlying credential shapes
// (`OpencodeDiscoveredData`, `OpencodeZenData`) live in `core/types.ts`
// because they're referenced from the `ProviderCredential` discriminated
// union.

import type { ProviderCredential, OpencodeZenData } from "../core/types"

export type { OpencodeZenData }
export type { DiscoveredOpencodeAuth, DiscoveredOpencodeEntry } from "../core/transport"

/**
 * Whitelisted OpenCode sub-providers. Only these are surfaced from
 * `~/.local/share/opencode/auth.json` — the Rust side filters everything
 * else out before we ever see it.
 */
export const OPENCODE_WHITELIST = ["anthropic", "openai", "opencode-zen"] as const
export type OpencodeWhitelistedSubProvider = (typeof OPENCODE_WHITELIST)[number]

export function isWhitelistedOpencodeSubProvider(s: string): s is OpencodeWhitelistedSubProvider {
  return OPENCODE_WHITELIST.includes(s as OpencodeWhitelistedSubProvider)
}

/** Form data for the "paste OpenCode-Zen API key" dialog. */
export interface OpencodeZenInput {
  /** Raw API key the user pasted. */
  accessToken: string
  /** Optional regional base URL — free-text today. */
  baseUrl?: string
  /** Optional user-supplied label; falls back to "OpenCode Zen". */
  label?: string
}

/** Wrap a Zen credential into the tagged `ProviderCredential` union. */
export function toOpencodeZenProviderCredential(c: OpencodeZenData): ProviderCredential {
  return { provider: "opencode-zen", ...c }
}
