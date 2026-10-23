import type { NativeSkillResource } from "@/lib/claude/ipc"

// CCSwitch interop types — importable content (MCP servers, prompts, skills).
// Mirrors the structs serialized by `crates/cognia-ccswitch/src/types.rs`.

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
  /** App the prompt belongs to ("claude" | "codex" | …). CCSwitch keys prompts by (id, app_type), so `id` alone is not unique. */
  kind?: string
  description?: string
  tags?: string[]
}

export interface CcswitchSkill {
  id: string
  name: string
  description?: string
  /** Installed SKILL.md, including frontmatter. Empty when the bundle cannot be read. */
  content: string
  /** Filesystem path when the skill is stored outside the DB. */
  sourcePath?: string
  resources?: NativeSkillResource[]
  openaiYaml?: string
}
