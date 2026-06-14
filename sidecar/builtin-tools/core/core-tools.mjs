// Assembler for the `coreFiles` builtin category — the unified core
// file-tool suite (grep/glob/read/ls/edit/multi_edit/write/bash/TodoWrite).
//
// Tools are emitted in the FIXED order of CORE_TOOL_NAMES: provider
// prompt-cache prefix matching requires the serialized tool list to be
// byte-stable across turns and sessions, so registration order must never
// depend on Map iteration, timing, or configuration order.
//
// `createCoreTools` is resolver-bound (like the lsp category): the dispatch
// layer supplies the per-session working directory, read tracker, and the
// lazy LSP resolver.

import { createGrepTool } from "./grep.mjs"
import { createGlobTool } from "./glob.mjs"
import { createReadTool } from "./read.mjs"
import { createLsTool } from "./ls.mjs"
import { createEditTool, createMultiEditTool } from "./edit.mjs"
import { createWriteTool } from "./write.mjs"
import { createBashTool, createBashOutputTool, createKillShellTool } from "./bash.mjs"
import { createTodoWriteTool, TODO_WRITE_NAME } from "./todo.mjs"
import { createNotebookEditTool, NOTEBOOK_EDIT_NAME } from "./notebook-edit.mjs"

/**
 * Fixed registration order — do not reorder (prompt-cache stability). New
 * tools are APPENDED at the end so the serialized prefix stays byte-stable.
 */
export const CORE_TOOL_NAMES = Object.freeze([
  "grep",
  "glob",
  "read",
  "ls",
  "edit",
  "multi_edit",
  "write",
  "bash",
  TODO_WRITE_NAME,
  "bash_output",
  "kill_shell",
  NOTEBOOK_EDIT_NAME,
])

/** Core tools that mutate state (restricted mode / IM channels deny these). */
export const CORE_MUTATING_TOOL_NAMES = Object.freeze([
  "edit",
  "multi_edit",
  "write",
  "bash",
  NOTEBOOK_EDIT_NAME,
])

/**
 * @param {{ cwd?: string, readTracker?: unknown, lspResolver?: unknown,
 *           bgShells?: unknown, model?: string, provider?: string }} ctx
 *   `bgShells` is the per-session background-shell registry (Module: async
 *   bash); `model`/`provider` let `read` decide whether to inline images.
 * @returns {Array} SdkMcpToolDefinitions in CORE_TOOL_NAMES order.
 */
export function createCoreTools({ cwd, readTracker, lspResolver, bgShells, model, provider } = {}) {
  const ctx = { cwd, readTracker, lspResolver, bgShells, model, provider }
  const tools = [
    createGrepTool(ctx),
    createGlobTool(ctx),
    createReadTool(ctx),
    createLsTool(ctx),
    createEditTool(ctx),
    createMultiEditTool(ctx),
    createWriteTool(ctx),
    createBashTool(ctx),
    createTodoWriteTool(),
    createBashOutputTool(ctx),
    createKillShellTool(ctx),
    createNotebookEditTool(ctx),
  ]
  // Defensive: the emitted order must match the public constant.
  for (let i = 0; i < tools.length; i++) {
    if (tools[i].name !== CORE_TOOL_NAMES[i]) {
      throw new Error(`core tool order drift: expected ${CORE_TOOL_NAMES[i]}, got ${tools[i].name}`)
    }
  }
  return tools
}
