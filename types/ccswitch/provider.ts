// CCSwitch interop types — provider records + DB status. Mirrors the structs
// serialized by `src-tauri/src/ccswitch/db.rs`. Field names follow the Rust
// struct's `serde(rename = "...")` attributes; everything not marked optional
// is always present (the Rust side fills empty strings before dropping rows).

/**
 * Shape of a single provider/subscription entry in `cc-switch.db`. CCSwitch
 * pre-fills 50+ providers (Anthropic, Kimi, DeepSeek, Qwen, …); users can
 * also add custom ones. Cognia-next reads but never writes.
 */
export interface CcswitchProvider {
  id: string
  name: string
  /** "claude" | "codex" | "gemini" | "opencode" | "openclaw" | other */
  kind?: string
  /**
   * The API key. Treat as a secret — don't log, don't preview in plaintext
   * outside the dialog where the user explicitly asks for "Show key".
   */
  apiKey?: string
  baseUrl?: string
  model?: string
  /** Free-form `sharedConfig` blob CCSwitch preserves across switches. */
  sharedConfig?: unknown
  notes?: string
}

export interface CcswitchCounts {
  providers: number
  mcpServers: number
  prompts: number
  skills: number
}

/**
 * Where the dbPath was resolved from. `"env"` = `CC_SWITCH_HOME` test
 * override; `"redirect"` = cc-switch's own `app_paths.json` re-pointed the
 * data directory (cloud-sync setups); `"default"` = `~/.cc-switch/`.
 */
export type CcswitchResolutionSource = "env" | "redirect" | "default"

export interface CcswitchStatus {
  /** Resolved DB path on this OS, or null when home dir can't be found. */
  dbPath: string | null
  exists: boolean
  counts: CcswitchCounts
  /** Filled in when the file existed but couldn't be opened/queried. */
  error?: string
  /** Where dbPath came from. Missing on legacy hosts. */
  resolutionSource?: CcswitchResolutionSource
}
