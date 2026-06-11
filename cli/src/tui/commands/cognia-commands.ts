/**
 * Slash-command descriptors for the Cognia runtime cluster (`/goal`,
 * `/workflow`, `/agents`, `/team`, `/memory`). Each handler is pure — it returns
 * a `runtime` {@link CommandEffect} the App routes to `runtime/index.ts`.
 */
import { rt } from "./runtime-handler"
import { loopCommand } from "./loop-command"
import type { CommandDescriptor } from "./types"

export const COGNIA_COMMANDS: CommandDescriptor[] = [
  {
    name: "goal",
    description: "start or control a self-driving goal loop",
    category: "cognia",
    argumentHint: "<objective | status | pause | resume | stop | list>",
    handler: rt("goal", "start"),
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
    description: "list, run, or inspect visual workflows",
    category: "cognia",
    handler: rt("workflow", "list"),
    subcommands: [
      { name: "list", description: "browse workflows", handler: rt("workflow", "list") },
      { name: "run", description: "run a workflow by id", handler: rt("workflow", "run") },
      { name: "inspect", description: "inspect a workflow", handler: rt("workflow", "inspect") },
      {
        name: "runs",
        description: "view a workflow's run history",
        handler: rt("workflow", "runs"),
      },
    ],
  },
  {
    name: "agents",
    description: "list and dispatch subagents",
    category: "cognia",
    handler: rt("agents", "list"),
    subcommands: [
      { name: "list", description: "list subagents", handler: rt("agents", "list") },
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
      { name: "run", description: "(desktop-only) run a team", handler: rt("team", "run") },
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
    name: "status",
    description: "show provider, credentials, git, and context health",
    category: "system",
    handler: rt("status", "show"),
  },
]
