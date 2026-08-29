/**
 * Tool type definitions for Agent functionality
 */

import type { z } from "zod"
import type { ToolState } from "../core/message"

export type AgentToolStatus = "pending" | "running" | "completed" | "error"

// Note: ToolStatus alias removed to avoid conflict with system/environment.ts
// Use AgentToolStatus instead

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<TInput>
  outputSchema?: z.ZodType<TOutput>
  execute: (input: TInput) => Promise<TOutput>
}

export interface ToolExecution {
  id: string
  toolName: string
  status: AgentToolStatus
  state: ToolState
  input: Record<string, unknown>
  output?: unknown
  error?: string
  startedAt: Date
  completedAt?: Date
  duration?: number
}

// Built-in tool names
export type BuiltInToolName =
  // Search tools
  | "web_search"
  | "web_scraper"
  | "bulk_web_scraper"
  | "search_and_scrape"
  | "rag_search"
  | "list_rag_collections"
  // Calculator & code
  | "calculator"
  | "execute_code"
  | "open_designer"
  // File tools
  | "file_read"
  | "file_write"
  | "file_binary_write"
  | "file_list"
  | "file_exists"
  | "file_delete"
  | "file_copy"
  | "file_rename"
  | "file_move"
  | "file_info"
  | "file_search"
  | "file_append"
  | "file_hash"
  | "file_diff"
  | "content_search"
  | "directory_create"
  | "directory_delete"
  // Document tools
  | "document_summarize"
  | "document_chunk"
  | "document_analyze"
  | "document_extract_tables"
  | "document_read_file"
  // Shell tools
  | "shell_execute"
  // Environment tools
  | "create_virtual_env"
  | "install_packages"
  | "uninstall_packages"
  | "upgrade_packages"
  | "run_python"
  | "run_python_file"
  | "run_in_env"
  | "get_python_info"
  | "list_env_packages"
  | "check_environments"
  | "get_python_versions"
  | "delete_virtual_env"
  | "export_requirements"
  | "import_requirements"
  // Process tools
  | "list_processes"
  | "search_processes"
  | "get_process"
  | "top_memory_processes"
  | "start_process"
  | "terminate_process"
  | "check_program_allowed"
  // Jupyter tools
  | "jupyter_execute"
  | "jupyter_start"
  | "jupyter_stop"
  // Video tools
  | "video_generate"
  | "video_status"
  | "video_subtitles"
  | "video_analyze"
  | "subtitle_parse"
  // Image tools
  | "image_generate"
  | "image_edit"
  | "image_variation"
  // Academic tools
  | "academic_search"
  | "academic_analysis"
  | "paper_comparison"
  // PPT tools
  | "ppt_outline"
  | "ppt_slide_content"
  | "ppt_finalize"
  | "ppt_export"
  // Learning tools
  | "display_flashcard"
  | "display_flashcard_deck"
  | "display_quiz"
  | "display_quiz_question"
  | "display_review_session"
  | "display_progress_summary"
  | "display_concept_explanation"
  | "display_step_guide"
  | "display_concept_map"
  | "display_animation"
  // Canvas tools — implemented in `lib/claude/artifact-builtin-tools.ts`,
  // routed host-side through `lib/claude/plugin-tool-ipc.ts`.
  | "canvas_create"
  | "canvas_update"
  | "canvas_read"
  | "canvas_open"
  // Artifact tools — same module. Three earlier names are deliberately gone:
  //   `artifact_search` — folded into `artifact_read`'s optional `query`. One
  //     optional field beats a whole extra schema in a manifest the model pays
  //     for on every turn.
  //   `artifact_render`  — nothing to ask for. The dock renders whatever is in
  //     the store the moment it lands.
  //   `artifact_export`  — a model-initiated write into the user's Downloads is
  //     a consent surface, and the payoff is a button the user is already
  //     looking at. `lib/artifacts/export/` is the human path.
  // `types/agent/tool.test.ts` pins this arm against the shipped manifest, so
  // adding a name here without implementing it fails a test rather than
  // becoming another entry nobody notices.
  | "artifact_create"
  | "artifact_update"
  | "artifact_read"
  | "artifact_delete"
  // Memory tools
  | "memory_store"
  | "memory_recall"
  | "memory_search"
  | "memory_forget"
  | "memory_list"

// MCP Tool extension
export interface MCPTool extends Omit<ToolDefinition, "execute"> {
  serverId: string
  serverName: string
}

export interface MCPServer {
  id: string
  name: string
  url: string
  tools: MCPTool[]
  connected: boolean
}
