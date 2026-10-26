/**
 * The brief-mode guidance appended when a session asks for concise answers.
 *
 * One definition shared by the chat assembler and any external route that
 * threads `briefMode` into its own session setup, so the wording cannot drift
 * between them (ADR-0236).
 */

import { definePrompt } from "@/lib/prompts/types"

export const BRIEF_MODE_PROMPT = definePrompt({
  id: "chat.brief-mode",
  contractVersion: 1,
  kind: "runtime-baseline",
  group: "chat",
  operation: "replace-template",
  scopes: ["account", "workspace", "agent"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 2_000,
  consumers: ["lib/claude/build-options.ts"],
  defaultBody:
    "Respond concisely. Skip preamble, headers, and bullet-list filler. Direct answers only — match length to the question.",
})
