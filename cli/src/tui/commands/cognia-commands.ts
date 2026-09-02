/**
 * Slash-command descriptors for the Cognia runtime cluster (`/goal`,
 * `/workflow`, `/agents`, `/team`, `/memory`). Each handler is pure — it returns
 * a `runtime` {@link CommandEffect} the App routes to `runtime/index.ts`.
 */
import { rt } from "./runtime-handler"
import { loopCommand } from "./loop-command"
import { planTitle } from "../runtime/plan"
import { formatPresetSnippets } from "../format/limits"
import type { CommandDescriptor } from "./types"

/** `/plan` (bare) — re-show this session's most recent plan from memory, or
 * point the user at plan mode / saved plans when there isn't one yet. */
const planRootHandler: CommandDescriptor["handler"] = (ctx) => {
  const last = ctx.state.lastPlan
  if (!last) {
    return {
      kind: "notice",
      message:
        "No plan yet. Switch to plan mode (Shift+Tab) and ask for a plan, or browse saved plans with /plan list.",
    }
  }
  return {
    kind: "openOverlay",
    overlay: { kind: "document", title: planTitle(last.raw), body: last.raw, format: "markdown" },
  }
}

/** `/plan refine` — drop back into plan mode and ask the agent to revise the
 * latest plan (the OpenCode "keep iterating after a build" loop). The App
 * performs the mode switch + seed turn; here we only guard for a plan existing. */
const planRefineHandler: CommandDescriptor["handler"] = (ctx) => {
  if (!ctx.state.lastPlan) {
    return {
      kind: "notice",
      message: "No plan to refine yet — propose one in plan mode (Shift+Tab) first.",
    }
  }
  return { kind: "planRefine" }
}

/** A copilot in-mode verb (apply/discard/save/exit) — routes the active draft's
 * workflow id (read from state) to the runtime, or notices when not in mode. */
const copilotAct =
  (action: string): NonNullable<CommandDescriptor["handler"]> =>
  (ctx) => {
    const wfId = ctx.state.copilot?.workflowId
    if (!wfId) return { kind: "notice", message: "Not in workflow copilot mode." }
    return { kind: "runtime", runtime: { feature: "workflow", action, arg: wfId } }
  }

export const COGNIA_COMMANDS: CommandDescriptor[] = [
  {
    name: "goal",
    description: "start or control a self-driving goal loop",
    category: "cognia",
    argumentHint: "<objective | status | pause | resume | stop | list>",
    // Starting streams each turn into the transcript, so it drives `agent.send`
    // through an App-level `goalRun` effect rather than the runtime router. The
    // control verbs below stay router calls (plain db reads/writes).
    handler: (ctx) => ({ kind: "goalRun", objective: ctx.args }),
    subcommands: [
      { name: "status", description: "show the active goal", handler: rt("goal", "status") },
      { name: "pause", description: "pause the active goal", handler: rt("goal", "pause") },
      { name: "resume", description: "resume the active goal", handler: rt("goal", "resume") },
      { name: "stop", description: "stop the active goal", handler: rt("goal", "stop") },
      { name: "list", description: "list this session's goals", handler: rt("goal", "list") },
    ],
  },
  {
    name: "workflow",
    aliases: ["wf"],
    description: "create, run, or inspect visual workflows",
    category: "cognia",
    handler: rt("workflow", "list"),
    subcommands: [
      { name: "list", description: "browse workflows", handler: rt("workflow", "list") },
      { name: "run", description: "run a workflow by id", handler: rt("workflow", "run") },
      { name: "inspect", description: "inspect a workflow", handler: rt("workflow", "inspect") },
      {
        name: "runs",
        description: "browse run history and replay a run",
        handler: rt("workflow", "runs"),
      },
      {
        name: "replay",
        description: "replay a run by id",
        argumentHint: "<runId>",
        handler: rt("workflow", "replay"),
      },
      {
        name: "create",
        description: "create a workflow with the copilot",
        argumentHint: "<name>",
        handler: rt("workflow", "create"),
      },
      {
        name: "edit",
        description: "edit a workflow with the copilot",
        argumentHint: "<id>",
        handler: rt("workflow", "edit"),
      },
      {
        name: "apply",
        description: "apply the open copilot proposal",
        handler: copilotAct("apply"),
      },
      {
        name: "discard",
        description: "discard the open copilot proposal",
        handler: copilotAct("discard"),
      },
      { name: "save", description: "save the workflow draft", handler: copilotAct("save") },
      { name: "exit", description: "leave workflow copilot mode", handler: copilotAct("exit") },
    ],
  },
  {
    name: "agents",
    description: "view running subagents, list, and dispatch",
    category: "cognia",
    handler: rt("agents", "panel"),
    subcommands: [
      {
        name: "panel",
        description: "open the interactive running-agents panel (Ctrl+B)",
        handler: rt("agents", "panel"),
      },
      { name: "list", description: "list subagents (text list)", handler: rt("agents", "list") },
      {
        name: "models",
        description: "assign a provider/model to each subagent",
        handler: rt("agents", "models"),
      },
      {
        name: "run",
        description: "dispatch a subagent: run <id> <prompt>",
        argumentHint: "<id> <prompt>",
        handler: rt("agents", "run"),
      },
    ],
  },
  {
    name: "team",
    description: "list and inspect agent teams",
    category: "cognia",
    handler: rt("team", "list"),
    subcommands: [
      { name: "list", description: "browse teams", handler: rt("team", "list") },
      { name: "show", description: "inspect a team by id", handler: rt("team", "show") },
      {
        name: "auto",
        description: "auto-compose a team from an objective",
        handler: rt("team", "auto"),
      },
      {
        name: "run",
        description: "run a desktop agent team and watch its progress",
        handler: rt("team", "run"),
      },
    ],
  },
  {
    name: "memory",
    aliases: ["mem"],
    description: "list, add, or remove stored memories",
    category: "cognia",
    argumentHint: "<list | add <text> | show <id> | delete <id>>",
    handler: rt("memory", "list"),
    subcommands: [
      { name: "list", description: "list stored memories", handler: rt("memory", "list") },
      {
        name: "add",
        description: "save a memory: add <text>",
        argumentHint: "<text>",
        handler: rt("memory", "add"),
      },
      { name: "show", description: "show a memory by id", handler: rt("memory", "show") },
      { name: "delete", description: "delete a memory by id", handler: rt("memory", "delete") },
    ],
  },
  {
    name: "remember",
    description: "save a fact to long-term memory",
    category: "cognia",
    argumentHint: "<text>",
    handler: rt("memory", "add"),
  },
  {
    name: "plan",
    description: "review the last plan, or browse saved plans",
    category: "cognia",
    argumentHint:
      "<(empty: show last) | explore <task> | list | show <id> | diff | delete <id> | refine>",
    handler: planRootHandler,
    subcommands: [
      {
        name: "explore",
        description: "research with Explore/Plan subagents, then propose a plan",
        argumentHint: "<task to plan>",
        handler: rt("plan", "explore"),
      },
      { name: "list", description: "browse saved plans", handler: rt("plan", "list") },
      { name: "show", description: "open a saved plan by id", handler: rt("plan", "show") },
      {
        name: "diff",
        description: "diff two saved plans (default: latest two)",
        handler: rt("plan", "diff"),
      },
      { name: "delete", description: "delete a saved plan by id", handler: rt("plan", "delete") },
      {
        name: "refine",
        description: "re-enter plan mode to revise the last plan",
        handler: planRefineHandler,
      },
    ],
  },
  loopCommand,
  {
    name: "tasks",
    description: "browse and control scheduled tasks",
    category: "cognia",
    argumentHint: "<list | show <id> | pause <id> | resume <id>>",
    handler: rt("tasks", "list"),
    subcommands: [
      { name: "list", description: "list scheduled tasks", handler: rt("tasks", "list") },
      { name: "show", description: "show a task by id", handler: rt("tasks", "show") },
      { name: "pause", description: "pause a task by id", handler: rt("tasks", "pause") },
      { name: "resume", description: "resume a task by id", handler: rt("tasks", "resume") },
    ],
  },
  {
    name: "council",
    description: "ask several models the same question and synthesize a consensus",
    category: "cognia",
    argumentHint: "<question> [--models a,b,c] [--synth alias]",
    handler: rt("council", "run"),
  },
  {
    name: "orchestrate",
    description: "analyze a task and run the best multi-model shape (council / ensemble / team)",
    category: "cognia",
    argumentHint: "<objective> [--consensus] [--verify]",
    handler: rt("orchestrate", "run"),
  },
  {
    name: "status",
    description: "show provider, credentials, git, and context health",
    category: "system",
    handler: rt("status", "show"),
  },
  {
    name: "models",
    description: "list this provider's models (catalog + live inventory) and switch",
    category: "system",
    handler: rt("provider", "models"),
  },
  {
    name: "balance",
    description: "show credit balances across configured providers",
    category: "system",
    handler: rt("provider", "balance"),
  },
  {
    name: "limits",
    aliases: ["usage-limits", "subscription"],
    description: "show subscription limits + usage across all configured providers",
    category: "system",
    handler: rt("limits", "show"),
    subcommands: [
      {
        name: "presets",
        description: "show custom-source preset config snippets (New-API, Copilot, …)",
        handler: () => ({
          kind: "openOverlay",
          overlay: {
            kind: "document",
            title: "Limits presets",
            body: formatPresetSnippets(),
            format: "markdown",
          },
        }),
      },
    ],
  },
]
