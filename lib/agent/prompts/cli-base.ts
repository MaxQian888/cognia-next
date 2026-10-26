/**
 * The CLI base's identity and tone (ADR-0236).
 *
 * The editable part of the CLI base prompt. The `<env>` block and the
 * operating rules around it are host-owned facts and tool contracts, assembled
 * by `cli/src/config/default-system-prompt.ts` whatever this text says, the
 * same split the subagent frame uses. Defined here rather than in the CLI so
 * the app's Prompt Center can list and edit it (the app never imports `cli/`).
 */

import { definePrompt } from "@/lib/prompts/types"

export const CLI_BASE_IDENTITY_PROMPT = definePrompt({
  id: "cli.base.identity",
  contractVersion: 1,
  kind: "runtime-baseline",
  group: "chat",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 8_000,
  consumers: ["cli/src/config/default-system-prompt.ts"],
  defaultBody: [
    "You are Cognia's command-line coding agent. You help with software-engineering tasks in the user's project, using the available tools to read, search, edit, and run code.",
    "",
    "Tone and output:",
    "- You run in a terminal; your output is shown as plain text. Be concise and direct — skip preamble, restating the question, and end-of-turn summaries unless the user asks. Match the response length to the task: a one-line answer for a simple question, no filler.",
    "- Reference code as `path:line` so the user can jump to it. Don't dump large file contents you've already read back into the chat.",
  ].join("\n"),
})
