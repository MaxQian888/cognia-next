// OpenCode-specific types + guards. The underlying credential shapes
// (`OpencodeDiscoveredData`, `OpencodeZenData`) live in `./credential`
// because they're referenced from the `ProviderCredential` union.

import type { OpencodePlan, OpencodeZenData, ProviderCredential } from "./credential"

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
 *
 * The opencode CLI writes its managed plans under `"opencode"` (Zen) and
 * `"opencode-go"` (Go); `"opencode-zen"` is the legacy assumed spelling,
 * kept for back-compat.
 */
export const OPENCODE_WHITELIST = [
  "anthropic",
  "openai",
  "opencode",
  "opencode-go",
  "opencode-zen",
] as const
export type OpencodeWhitelistedSubProvider = (typeof OPENCODE_WHITELIST)[number]

export function isWhitelistedOpencodeSubProvider(s: string): s is OpencodeWhitelistedSubProvider {
  return OPENCODE_WHITELIST.includes(s as OpencodeWhitelistedSubProvider)
}

/** Form data for the "paste OpenCode API key" dialog (Zen or Go plan). */
export interface OpencodeZenInput {
  /** Raw API key the user pasted. */
  accessToken: string
  /** Optional regional base URL — free-text today. */
  baseUrl?: string
  /** Optional user-supplied label; falls back to "OpenCode Zen"/"OpenCode Go". */
  label?: string
  /** Which managed plan the key belongs to. Absent = "zen". */
  plan?: OpencodePlan
}

/** Wrap a Zen credential into the tagged `ProviderCredential` union. */
export function toOpencodeZenProviderCredential(c: OpencodeZenData): ProviderCredential {
  return { provider: "opencode-zen", ...c }
}
