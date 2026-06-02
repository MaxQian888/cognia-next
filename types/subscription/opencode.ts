// OpenCode-specific types + guards. The underlying credential shapes
// (`OpencodeDiscoveredData`, `OpencodeZenData`) live in `./credential`
// because they're referenced from the `ProviderCredential` union.

import type { OpencodeZenData, ProviderCredential } from "./credential"

// IPC response shapes for OpenCode discovery live with the transport layer
// (they are tied to the Tauri command surface); re-exported here so callers
// can reach the whole OpenCode type surface from one place.
export type {
  DiscoveredOpencodeAuth,
  DiscoveredOpencodeEntry,
} from "@/lib/subscription/core/transport"

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
