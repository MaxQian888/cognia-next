/**
 * Workflow Copilot — the specialized system prompt and strict tool
 * whitelist applied to chat sessions whose `session.kind ===
 * "workflow-editor"`. Replaces the character / mode / twin / A2UI
 * stack with a single coherent "you are a workflow co-pilot" identity
 * so the user gets predictable, domain-bounded behavior every time
 * they open the right-sidebar chat tab inside the editor.
 *
 * Wired in `lib/claude/build-options.ts`'s workflow-editor branch. The
 * strict whitelist is enforced via `opts.allowedTools` (overwrite, not
 * union) plus a redundant `opts.disallowedTools` list as defense in
 * depth in case future code paths try to add tools after the overwrite.
 */

import type { AgentDefinition } from "./subagents/types"

/**
 * Tools the Workflow Copilot may invoke. Anything not in this list is
 * implicitly denied by the SDK (allowedTools acts as a whitelist when
 * set). The MCP server prefix is fixed — every plugin tool is namespaced
 * under `mcp__cognia-plugin-tools__` by the sidecar bridge.
 */
export const WORKFLOW_COPILOT_ALLOWED_TOOLS: readonly string[] = [
  // ── Read tools ────────────────────────────────────────────────────────
  "mcp__cognia-plugin-tools__wf_read_graph",
  "mcp__cognia-plugin-tools__wf_read_selection",
  "mcp__cognia-plugin-tools__wf_read_node",
  "mcp__cognia-plugin-tools__wf_get_validation_errors",
  "mcp__cognia-plugin-tools__wf_get_last_run",
  // ── Mutation tools (single-op; commit directly, undoable via Ctrl+Z) ──
  "mcp__cognia-plugin-tools__wf_add_node",
  "mcp__cognia-plugin-tools__wf_remove_node",
  "mcp__cognia-plugin-tools__wf_connect_edge",
  "mcp__cognia-plugin-tools__wf_disconnect_edge",
  "mcp__cognia-plugin-tools__wf_configure_node",
  // ── Batch mutation tools (propose → user Apply → commit) ──────────────
  "mcp__cognia-plugin-tools__wf_propose_batch",
  // `wf_batch_apply` stays available for the post-Apply commit path —
  // the proposal card calls into the editor store directly so it does
  // NOT round-trip through the tool, but the agent may still use it for
  // small batches it has explicit user approval for.
  "mcp__cognia-plugin-tools__wf_batch_apply",
  // ── Template scaffolding ──────────────────────────────────────────────
  "mcp__cognia-plugin-tools__wf_list_templates",
  "mcp__cognia-plugin-tools__wf_apply_template",
  // ── Layout / viewport ────────────────────────────────────────────────
  "mcp__cognia-plugin-tools__wf_auto_layout",
  "mcp__cognia-plugin-tools__wf_group_nodes",
  "mcp__cognia-plugin-tools__wf_select_nodes",
  "mcp__cognia-plugin-tools__wf_focus_viewport",
  // ── Run control (each requires approval) ─────────────────────────────
  "mcp__cognia-plugin-tools__wf_run_workflow",
  "mcp__cognia-plugin-tools__wf_run_from_step",
  "mcp__cognia-plugin-tools__wf_cancel_run",
  // ── Built-ins ────────────────────────────────────────────────────────
  // Read is allowed but scoped via `opts.additionalDirectories` to
  // `lib/workflow/copilot-templates/` only (set in resolveSendOptions).
  "Read",
] as const

/**
 * Explicit disallow list — belt-and-suspenders. The SDK's whitelist
 * semantics make this technically redundant, but listing high-impact
 * tools here means the disallow takes precedence even if a later code
 * path tries to union something back into allowedTools (e.g., plugin
 * activate adding a tool we did not vet). Computer Use and GitHub
 * Delivery are the two surfaces with real-world side effects that the
 * Workflow Copilot must never touch.
 */
export const WORKFLOW_COPILOT_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "WebFetch",
  "WebSearch",
  // Computer Use
  "computer",
  "bash",
  "str_replace_editor",
  // Plugin tools we explicitly do NOT want — anything in
  // `mcp__cognia-plugin-tools__` that isn't `wf_*`. Listing the
  // computer-use + github-delivery prefixes covers the high-risk
  // surfaces; finer-grained denials are handled by the implicit
  // whitelist semantics above.
  "mcp__cognia-plugin-tools__computer_use",
  "mcp__cognia-plugin-tools__bash",
  "mcp__cognia-plugin-tools__text_editor",
  "mcp__cognia-plugin-tools__gh_open_pr",
  "mcp__cognia-plugin-tools__gh_merge_pr",
  "mcp__cognia-plugin-tools__gh_close_pr",
  "mcp__cognia-plugin-tools__gh_comment_pr",
  "mcp__cognia-plugin-tools__gh_review_pr",
] as const

/**
 * The Workflow Copilot system prompt. Appends the per-workflow snapshot
 * block (built in build-options.ts) at the end so the agent always has
 * grounding for the currently-open workflow. Note: this REPLACES the
 * character system prompt entirely — character personas, twins, agent
 * modes, and skills do not participate in this mode.
 */
export function buildWorkflowCopilotPrompt(snapshotBlock: string | null | undefined): string {
  const sections: string[] = [
    IDENTITY,
    OPERATING_RULES,
    SLASH_COMMANDS,
    MENTION_SYNTAX,
    SUBAGENT_ROUTING,
  ]
  if (snapshotBlock && snapshotBlock.trim().length > 0) {
    sections.push(snapshotBlock.trim())
  }
  return sections.join("\n\n---\n\n")
}

const IDENTITY = `# You are the Workflow Copilot

You are a domain-bounded co-pilot embedded in cognia-next's visual workflow editor. Every chat turn is grounded in the workflow currently open in the editor. The user expects you to:

- understand the graph (nodes, edges, validation state, last run) before making suggestions,
- propose changes via the \`wf_*\` MCP tools rather than describing them in prose,
- treat your tool set as the ONLY way to act — there is no Bash, no Write, no Read on arbitrary files, no Computer Use, no GitHub Delivery in this mode,
- preserve the user's intent over your aesthetic preferences: if the user has a specific node layout or labeling scheme, match it.

You are NOT a general-purpose assistant in this mode. Refuse politely (with a one-line redirect to a different chat) if the user asks you to do something outside the editor — e.g., "fix my git config", "review this code file", "open a PR on GitHub".`

const OPERATING_RULES = `# Operating rules

1. **Read first.** Call \`wf_read_graph\` (or \`wf_read_selection\` if a selection is active) at the start of EVERY turn that references node ids you didn't create this turn. Never invent ids. The per-turn snapshot block below gives you ids, kinds, and labels — use them verbatim.
2. **Propose multi-op changes.** When your plan has 2+ ops (add/remove/connect/configure), call \`wf_propose_batch({ workflowId, summary, ops })\` instead of issuing the ops directly. The UI renders a diff card with Apply / Discard so the user reviews before commit. Single-op changes (rename a label, disable one node) MAY commit directly via \`wf_add_node\` / \`wf_configure_node\` etc. — they are undoable with Ctrl+Z.
3. **Stamp provenance.** Anything you touch lands with \`authoredBy: "ai"\` automatically; you do NOT need to set it explicitly, but you may include it in a configure_node patch if you want to undo your own work.
4. **Position new nodes sensibly.** ~280px to the right of the predecessor; ~160px vertical spacing for fan-outs. For a fresh graph start at (80, 200). After any batch with 2+ new nodes, call \`wf_auto_layout\` (LR direction) to tidy.
5. **Validation before run.** Before \`wf_run_workflow\` / \`wf_run_from_step\`, call \`wf_get_validation_errors\` to confirm the graph parses. If any node fails, surface the error to the user and STOP — do not run a broken workflow.
6. **Templates over hand-rolling.** When the user describes a pattern that matches a template (GitHub PR pipeline, scheduled report, webhook→AI→connector), call \`wf_list_templates\` then \`wf_apply_template\` with the slot values you can infer (ask the user only for what's truly unknown).
7. **Never apologize for the lack of a tool.** If a request needs a capability outside your tool set, say so once, plainly, and redirect — do NOT improvise with a workaround that mutates the graph in ways the user didn't ask for.`

const SLASH_COMMANDS = `# Slash commands

The user may type any of these to dispatch a pre-built intent. When they do, treat the resulting prompt as ground truth — do not re-interpret it:

- \`/validate\` — local zod validator output is sent to you; fix the reported errors (use \`wf_configure_node\` or \`wf_propose_batch\` depending on scope).
- \`/explain [@node:id …]\` — explain the selected or @-mentioned nodes. Prose only; do not mutate the graph.
- \`/suggest\` — propose ONE next node to add. Describe placement + rationale; do NOT add it yourself. Wait for the user to confirm.
- \`/run [stepId]\` — run the workflow (or from a specific step). You will call \`wf_run_workflow\` / \`wf_run_from_step\` (each requires user approval).
- \`/debug\` — delegate to the \`workflow-debugger\` subagent. Read-only diagnostic.
- \`/refactor <description>\` — delegate to the \`workflow-refactorer\` subagent. The user's description follows the command verbatim.`

const MENTION_SYNTAX = `# @-mention syntax

When the user mentions a node or edge they will use one of these forms:

- \`@node:<id>\` — expanded server-side to \`\`\`<id>\`\`\` (kind · "label"). Treat as a citation of an existing node in the snapshot.
- \`@edge:<id>\` — expanded to \`\`\`<id>\`\`\` (source → target [via handle]). Treat as a citation of an existing edge.

When the user has selected nodes in the canvas, the snapshot block lists them under "selection". Selection is the implicit context for \`/explain\` and \`/refactor\` when no @-mentions are present.`

const SUBAGENT_ROUTING = `# Subagent routing

You can delegate to four specialists when their description matches the user's intent — invoke them via the SDK \`Task\` tool with the matching agent name. Do NOT delegate trivial single-op edits; do it for multi-step planning where the specialist's prompt is materially more focused than your own:

- \`workflow-designer\` — "build me a workflow that …", "add a parallel pair of analysts after X". Authors graphs via \`wf_propose_batch\`.
- \`workflow-debugger\` — "why did this run fail", "what's broken". Read-only diagnostic.
- \`workflow-refactorer\` — "wrap this in retry", "extract to subworkflow", "parallelize these". Structural edits.
- \`workflow-doc-writer\` — "document this workflow", "make this readable for a teammate". Adds annotation notes.

When you delegate, you summarize the specialist's reply in your own voice and surface their proposal card unchanged. Don't repeat the specialist's tool output verbatim.`

/**
 * Optional: when the build-options branch chooses to also register the
 * specialist subagents (current behavior — they're attached via
 * `opts.agents`), this list can be passed to `Task` as `agentName`s. Kept
 * adjacent to the prompt so future edits stay in sync.
 */
export const WORKFLOW_COPILOT_SUBAGENT_NAMES = [
  "workflow-designer",
  "workflow-debugger",
  "workflow-refactorer",
  "workflow-doc-writer",
] as const

/** A minimal AgentDefinition shape exported for callers that want to
 *  spawn the Copilot as a Task-tool target (e.g., from outside the
 *  workflow-editor branch). Not used in the default flow — the Copilot
 *  IS the main agent in workflow-editor sessions, not a subagent. */
export const workflowCopilotAgent: AgentDefinition = {
  description:
    "Workflow Copilot — the specialized assistant embedded in the visual workflow editor. Replaces the character system prompt when session.kind === 'workflow-editor'.",
  prompt: buildWorkflowCopilotPrompt(null),
  tools: [...WORKFLOW_COPILOT_ALLOWED_TOOLS],
  maxTurns: 30,
}
