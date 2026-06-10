/**
 * Slash-command descriptors for the Claude-Code / OpenCode parity cluster:
 * `/context`, `/compact`, `/export`, `/resume`, `/doctor`, `/init`.
 *
 * `/context` and `/compact` are pure handlers (a notice / a send). `/export`,
 * `/doctor`, and `/init` emit a `runtime` {@link CommandEffect} routed to their
 * controllers in `runtime/index.ts`. `/resume` emits the dedicated `resumeLast`
 * effect the App resolves against the session store.
 */
import { buildCompactEffect } from "./compact-effect"
import { buildContextReport } from "./context-report"
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const PARITY_COMMANDS: CommandDescriptor[] = [
  {
    name: "context",
    aliases: ["ctx"],
    description: "show context-window usage and what's loaded",
    category: "system",
    handler: (ctx) => ({
      kind: "notice",
      message: buildContextReport(ctx.state.usage, ctx.config),
    }),
  },
  {
    name: "compact",
    description: "compact the conversation to free context (Anthropic)",
    category: "system",
    argumentHint: "[focus instructions]",
    handler: buildCompactEffect,
  },
  {
    name: "export",
    description: "export this session to a file",
    category: "session",
    argumentHint: "[markdown | json | jsonl]",
    handler: rt("export", "run"),
  },
  {
    name: "resume",
    aliases: ["continue"],
    description: "resume the most recent session",
    category: "session",
    handler: () => ({ kind: "resumeLast" }),
  },
  {
    name: "doctor",
    description: "diagnose config, credentials, and the local store",
    category: "system",
    handler: rt("doctor", "run"),
  },
  {
    name: "permissions",
    aliases: ["allowed-tools"],
    description: "view or clear remembered tool approvals",
    category: "config",
    handler: rt("permissions", "list"),
    subcommands: [
      { name: "list", description: "list approvals", handler: rt("permissions", "list") },
      {
        name: "clear",
        description: "forget every always-allowed tool",
        handler: rt("permissions", "clear"),
      },
    ],
  },
  {
    name: "init",
    description: "scaffold an AGENTS.md for this project",
    category: "system",
    handler: rt("init", "run"),
  },
]
