// CCSwitch interop types — importable content (MCP servers, prompts, skills).
// Mirrors the structs serialized by `src-tauri/src/ccswitch/db.rs`.

export interface CcswitchMcpServer {
  id: string
  name: string
  transport?: string
  /** Full MCP server config exactly as CCSwitch stores it. */
  config?: Record<string, unknown> | unknown[] | string | number | boolean | null
  notes?: string
}

export interface CcswitchPrompt {
  id: string
  name: string
  content: string
  description?: string
  tags?: string[]
}

export interface CcswitchSkill {
  id: string
  name: string
  description?: string
  /** Markdown body. Empty when CCSwitch references the skill by external path. */
  content: string
  /** Filesystem path when the skill is stored outside the DB. */
  sourcePath?: string
}
