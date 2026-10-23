/**
 * The plugin contract's share of `lib/claude/mcp-presets.ts`, which re-exports these.
 */
export interface McpPresetField {
  /** The key under which the user's value lives. For env vars: env name.
   *  For headers: header name. For url: ignored (single field per preset). */
  key: string
  label: string
  /**
   * Where this value plugs into the config:
   *   - "env": stdio-only environment variable.
   *   - "arg-replace": stdio-only argv token swap.
   *   - "url": http/sse URL — replaces `config.url` directly.
   *   - "header": http/sse header — written under `config.headers[key]`.
   */
  placement: "env" | "arg-replace" | "url" | "header"
  /** When placement === "arg-replace", which token to swap (e.g. "<PATH>"). */
  token?: string
  description?: string
  placeholder?: string
  /** If true, render as a password field. */
  secret?: boolean
}
