/**
 * Workflow Copilot slash commands.
 *
 * Six built-in commands available only inside workflow-editor sessions:
 *
 *   /validate          run the local schema validator + ask the agent to fix
 *   /explain [@mention]explain the selected or @-mentioned nodes
 *   /suggest           propose one next node to add
 *   /run [stepId]      run the workflow (or from a specific step) — needs approval
 *   /debug             delegate to the workflow-debugger subagent
 *   /refactor <desc>   delegate to the workflow-refactorer subagent
 *
 * Why a custom DOM event + chat-tab listener instead of extending
 * SlashContext? Three reasons:
 *   1. The slash-command path is shared by every chat surface — the main
 *      chat composer and the workflow-editor chat tab use the same
 *      `handleSlashCommand` in composer.tsx. Adding a `dispatchPrompt`
 *      callback to SlashContext means the main chat would also have to
 *      wire it up, which it shouldn't.
 *   2. The workflow editor chat tab already owns the `claude.send` path
 *      that the bottom-toolbar quick actions go through — the slash
 *      handler just needs to nudge that pathway. A CustomEvent is a
 *      clean one-way signal.
 *   3. Gating: the chat-tab listener is mounted only inside
 *      WorkflowEditorChatTab, so events emitted from non-workflow
 *      surfaces are silently dropped. The slash commands also self-gate
 *      via the `activeSessionId.startsWith("workflow:")` check so the
 *      picker never lists them outside the editor.
 */

import type { SlashCommand, SlashContext } from "../builtin"

export const WORKFLOW_COPILOT_DISPATCH_EVENT = "workflow-copilot:dispatch-action"

export type WorkflowSubagentAlias = "designer" | "debugger" | "refactorer" | "doc-writer"

export const WORKFLOW_SUBAGENT_ALIAS_TO_NAME: Record<WorkflowSubagentAlias, string> = {
  designer: "workflow-designer",
  debugger: "workflow-debugger",
  refactorer: "workflow-refactorer",
  "doc-writer": "workflow-doc-writer",
}

export type WorkflowSlashAction =
  | { kind: "validate" }
  | { kind: "explain"; args: string }
  | { kind: "suggest" }
  | { kind: "run"; stepId?: string }
  | { kind: "debug" }
  | { kind: "refactor"; description: string }
  | { kind: "delegate"; alias: WorkflowSubagentAlias; task: string }

export interface WorkflowDispatchEventDetail {
  action: WorkflowSlashAction
}

/**
 * Dispatch the action via a global CustomEvent. Returns `true` when the
 * runtime supports `window.dispatchEvent` (i.e., in the browser); in
 * non-DOM contexts (unit tests, sidecar) we no-op so the handler stays
 * pure.
 */
export function dispatchWorkflowSlashAction(action: WorkflowSlashAction): boolean {
  if (typeof window === "undefined" || typeof CustomEvent !== "function") return false
  window.dispatchEvent(
    new CustomEvent<WorkflowDispatchEventDetail>(WORKFLOW_COPILOT_DISPATCH_EVENT, {
      detail: { action },
    })
  )
  return true
}

function inWorkflowEditorSession(ctx: SlashContext): boolean {
  return (ctx.activeSessionId ?? "").startsWith("workflow:")
}

function refuseOutsideEditor(ctx: SlashContext, commandName: string): void {
  ctx.pushSystemMessage(
    `\`/${commandName}\` is only available inside the workflow editor's right-sidebar chat.`
  )
}

export const WORKFLOW_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "validate",
    description: "Run the local schema validator and ask the agent to fix any issues it reports.",
    scope: "builtin",
    category: "workflow",
    handler: (ctx) => {
      if (!inWorkflowEditorSession(ctx)) return refuseOutsideEditor(ctx, "validate")
      dispatchWorkflowSlashAction({ kind: "validate" })
    },
  },
  {
    name: "explain",
    description: "Explain the selected or @-mentioned nodes in prose. Read-only.",
    scope: "builtin",
    category: "workflow",
    argumentHint: "[@node:id …]",
    handler: (ctx) => {
      if (!inWorkflowEditorSession(ctx)) return refuseOutsideEditor(ctx, "explain")
      dispatchWorkflowSlashAction({ kind: "explain", args: ctx.args.trim() })
    },
  },
  {
    name: "suggest",
    description: "Propose one next node to add (kind, position, rationale). Doesn't auto-apply.",
    scope: "builtin",
    category: "workflow",
    handler: (ctx) => {
      if (!inWorkflowEditorSession(ctx)) return refuseOutsideEditor(ctx, "suggest")
      dispatchWorkflowSlashAction({ kind: "suggest" })
    },
  },
  {
    name: "run",
    description: "Run the workflow (or from a specific step). Requires user approval.",
    scope: "builtin",
    category: "workflow",
    argumentHint: "[stepId]",
    handler: (ctx) => {
      if (!inWorkflowEditorSession(ctx)) return refuseOutsideEditor(ctx, "run")
      const stepId = ctx.args.trim()
      dispatchWorkflowSlashAction({ kind: "run", stepId: stepId.length > 0 ? stepId : undefined })
    },
  },
  {
    name: "debug",
    description:
      "Diagnose a failed run or red validation badges via the workflow-debugger subagent (read-only).",
    scope: "builtin",
    category: "workflow",
    handler: (ctx) => {
      if (!inWorkflowEditorSession(ctx)) return refuseOutsideEditor(ctx, "debug")
      dispatchWorkflowSlashAction({ kind: "debug" })
    },
  },
  {
    name: "refactor",
    description:
      "Restructure a subgraph via the workflow-refactorer subagent. Preserves observable behavior.",
    scope: "builtin",
    category: "workflow",
    argumentHint: "<description>",
    handler: (ctx) => {
      if (!inWorkflowEditorSession(ctx)) return refuseOutsideEditor(ctx, "refactor")
      const description = ctx.args.trim()
      if (description.length === 0) {
        ctx.pushSystemMessage(
          "Usage: `/refactor <description>` — e.g. `/refactor wrap the AI step in retry + fallback`."
        )
        return
      }
      dispatchWorkflowSlashAction({ kind: "refactor", description })
    },
  },
  {
    name: "delegate",
    description:
      "Explicit handoff to one of the four workflow specialists (designer / debugger / refactorer / doc-writer).",
    scope: "builtin",
    category: "workflow",
    argumentHint: "<designer|debugger|refactorer|doc-writer> <task...>",
    handler: (ctx) => {
      if (!inWorkflowEditorSession(ctx)) return refuseOutsideEditor(ctx, "delegate")
      const parsed = parseDelegateArgs(ctx.args)
      if (!parsed.ok) {
        ctx.pushSystemMessage(parsed.message)
        return
      }
      dispatchWorkflowSlashAction({
        kind: "delegate",
        alias: parsed.alias,
        task: parsed.task,
      })
    },
  },
]

/**
 * Parse `/delegate <alias> <task...>`. Returns a typed payload or an
 * error message ready for `pushSystemMessage`. Exported for unit tests.
 */
export function parseDelegateArgs(
  raw: string
): { ok: true; alias: WorkflowSubagentAlias; task: string } | { ok: false; message: string } {
  const trimmed = (raw ?? "").trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      message:
        "Usage: `/delegate <designer|debugger|refactorer|doc-writer> <task>` — e.g. `/delegate debugger why is the cron node not firing?`.",
    }
  }
  const [aliasRaw, ...rest] = trimmed.split(/\s+/)
  const alias = aliasRaw.toLowerCase() as WorkflowSubagentAlias
  if (!(alias in WORKFLOW_SUBAGENT_ALIAS_TO_NAME)) {
    return {
      ok: false,
      message: `Unknown subagent alias \`${aliasRaw}\`. Pick one of: ${Object.keys(
        WORKFLOW_SUBAGENT_ALIAS_TO_NAME
      ).join(", ")}.`,
    }
  }
  const task = rest.join(" ").trim()
  if (task.length === 0) {
    return {
      ok: false,
      message: `Provide a task description after \`/delegate ${alias}\`.`,
    }
  }
  return { ok: true, alias, task }
}

/**
 * Build the user-prompt the chat-tab listener dispatches to the agent
 * once it receives a workflow slash action. Pure / synchronous so tests
 * can exercise the wording without DOM. Validate / explain / suggest are
 * built elsewhere (lib/workflow/editor/quick-action-prompts.ts) because
 * they need editor-store access; this file covers the prompts that are
 * independent of editor state.
 */
export function buildWorkflowSlashPrompt(action: WorkflowSlashAction): string | null {
  switch (action.kind) {
    case "run":
      if (action.stepId) {
        return [
          `/run \`${action.stepId}\``,
          "",
          `Please execute this workflow starting from step \`${action.stepId}\` via \`wf_run_from_step\`. The run requires user approval — surface a clear approval prompt with the workflow name and entry summary.`,
        ].join("\n")
      }
      return [
        "/run",
        "",
        "Please execute the entire workflow now via `wf_run_workflow`. Before calling the tool, run `wf_get_validation_errors` to confirm the graph parses — if anything fails, list the issues and stop. The run requires user approval; surface a clear approval prompt with the workflow name and entry summary.",
      ].join("\n")
    case "debug":
      return [
        "/debug",
        "",
        "Please delegate to the `workflow-debugger` subagent. It should read the graph, validation errors, and last-run summary, then explain the root cause and suggested fix in prose. Do NOT mutate the graph.",
      ].join("\n")
    case "refactor":
      return [
        `/refactor ${action.description}`,
        "",
        `Please delegate to the \`workflow-refactorer\` subagent to: ${action.description}.`,
        "",
        "The refactor MUST preserve observable behavior. Use `wf_propose_batch` for any multi-op change so the user can review the diff before commit.",
      ].join("\n")
    case "delegate": {
      const subagentName = WORKFLOW_SUBAGENT_ALIAS_TO_NAME[action.alias]
      return [
        `/delegate ${action.alias} ${action.task}`,
        "",
        `Please delegate to the \`${subagentName}\` subagent via the \`Task\` tool. The user's task is:`,
        "",
        action.task,
        "",
        "Summarize the subagent's reply in your own voice once it completes. Don't repeat the specialist's tool output verbatim.",
      ].join("\n")
    }
    default:
      return null
  }
}

/**
 * Helper to register all six commands into the slash-command registry.
 * Called from `lib/slash-commands/builtin.ts:seedBuiltinSlashCommands`
 * via `BUILTIN_SLASH_COMMANDS` concatenation.
 */
export function listWorkflowSlashCommands(): readonly SlashCommand[] {
  return WORKFLOW_SLASH_COMMANDS
}
