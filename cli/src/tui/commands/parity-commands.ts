/**
 * Slash-command descriptors for the Claude-Code / OpenCode parity cluster:
 * `/context`, `/compact`, `/export`, `/resume`, `/continue`, `/doctor`, `/init`.
 *
 * `/context` and `/compact` are pure handlers (a notice / a send). `/export`,
 * `/doctor`, and `/init` emit a `runtime` {@link CommandEffect} routed to their
 * controllers in `runtime/index.ts`. `/resume` opens the session-selection
 * panel (the `openSessions` effect, shared with `/sessions`); `/continue` emits
 * the dedicated `resumeLast` effect the App resolves against the session store.
 */
import { buildCompactEffect } from "./compact-effect"
import { rt } from "./runtime-handler"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** Parse `<seq>` and build a `/rewind` restore effect (or a usage notice). */
function rewindEffect(
  ctx: CommandContext,
  scope: "conversation" | "files" | "both"
): CommandEffect {
  const seq = Number(ctx.args.trim())
  if (!Number.isInteger(seq) || seq < 0) {
    return { kind: "notice", message: `Usage: /rewind ${scope === "both" ? "apply" : scope} <seq>` }
  }
  return { kind: "rewind", seq, scope }
}

export const PARITY_COMMANDS: CommandDescriptor[] = [
  {
    name: "context",
    aliases: ["ctx"],
    description: "show context-window usage and what's loaded",
    category: "system",
    // Routes through the runtime so it can append the SDK's live, authoritative
    // context breakdown (getContextUsage) on top of the pure estimate.
    handler: rt("context", "run"),
  },
  {
    name: "compact",
    description: "compact the conversation to free context",
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
    description: "pick a past session to resume",
    category: "session",
    // Opens the session-selection panel (the same picker `/sessions` uses) so
    // the user can choose which conversation to restore — mirrors Claude Code's
    // `--resume`. The direct "most recent" path is `/continue` below.
    handler: () => ({ kind: "openSessions" }),
  },
  {
    name: "continue",
    description: "resume the most recent session directly",
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
    name: "hooks",
    description: "list active settings.json lifecycle hooks",
    category: "system",
    handler: rt("hooks", "list"),
    subcommands: [{ name: "list", description: "list active hooks", handler: rt("hooks", "list") }],
  },
  {
    name: "rewind",
    description: "restore files and/or conversation to an earlier checkpoint",
    category: "session",
    argumentHint: "[apply <seq> | files <seq> | conversation <seq>]",
    handler: () => ({ kind: "rewindList" }),
    subcommands: [
      {
        name: "apply",
        description: "restore both conversation and files",
        handler: (ctx) => rewindEffect(ctx, "both"),
      },
      {
        name: "files",
        description: "restore only the files",
        handler: (ctx) => rewindEffect(ctx, "files"),
      },
      {
        name: "conversation",
        description: "restore only the conversation",
        handler: (ctx) => rewindEffect(ctx, "conversation"),
      },
    ],
  },
  {
    name: "add-dir",
    description: "let the agent read an extra working directory",
    category: "config",
    argumentHint: "<path> | remove <path|index> | list",
    handler: (ctx) => ({ kind: "addDir", op: "add", arg: ctx.args }),
    subcommands: [
      {
        name: "list",
        description: "list the extra roots",
        handler: () => ({ kind: "addDir", op: "list", arg: "" }),
      },
      {
        name: "remove",
        description: "remove an extra root by path or index",
        handler: (ctx) => ({ kind: "addDir", op: "remove", arg: ctx.args }),
      },
    ],
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
        name: "remove",
        description: "forget one always-allowed tool by name",
        argumentHint: "<tool>",
        handler: rt("permissions", "remove"),
      },
      {
        name: "clear",
        description: "forget every always-allowed tool",
        handler: rt("permissions", "clear"),
      },
    ],
  },
  {
    name: "init",
    description: "create or improve this project's AGENTS.md",
    category: "system",
    argumentHint: "[create | rewrite | preview | scaffold]",
    handler: rt("init", "run"),
    subcommands: [
      {
        name: "create",
        description: "regenerate the AGENTS.md template (confirm before overwrite)",
        handler: rt("init", "create"),
      },
      {
        name: "regenerate",
        description: "alias for create",
        handler: rt("init", "create"),
      },
      {
        name: "rewrite",
        description: "rewrite AGENTS.md with the current model (confirm before overwrite)",
        handler: rt("init", "rewrite"),
      },
      {
        name: "optimize",
        description: "alias for rewrite",
        handler: rt("init", "rewrite"),
      },
      {
        name: "preview",
        description: "preview the current AGENTS.md",
        handler: rt("init", "preview"),
      },
      {
        name: "scaffold",
        description: "seed .cognia/instructions/*.md and an example subagent",
        handler: rt("init", "scaffold"),
      },
      {
        name: "apply",
        description: "apply the pending AGENTS.md change",
        handler: rt("init", "apply"),
      },
    ],
  },
]
