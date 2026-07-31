/**
 * Shared types for the "interactive page from execution" bridge.
 *
 * The bridge takes an execution *source* (a completed workflow run, a chat
 * conversation) and projects it into a portable A2UI app (`GeneratedApp` from
 * the existing app-generator), which then flows unchanged into the mini-app
 * hub (save/edit) and the zero-knowledge share pipeline (read-only collab).
 */

import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import type { VisualWorkflow, WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

/** A completed (or terminal) workflow run plus its event log. */
export interface WorkflowRunPageSource {
  kind: "workflow-run"
  run: WorkflowRunRow
  events: WorkflowRunEventRow[]
  /** Falls back to `run.workflowSnapshot.name` when omitted. */
  workflowName?: string
}

/** A chat session plus its persisted messages, oldest-first. */
export interface ConversationPageSource {
  kind: "conversation"
  session: ChatSession
  messages: StoredMessage[]
}

export type ExecutionPageSource = WorkflowRunPageSource | ConversationPageSource

/** Localized strings the projectors need (kept injectable for i18n + tests). */
export interface ExecutionPageLabels {
  status: string
  trigger: string
  duration: string
  tokens: string
  cost: string
  steps: string
  succeeded: string
  failed: string
  stepBreakdown: string
  stepDuration: string
  tokenBurn: string
  outputs: string
  error: string
  /** Conversation labels. */
  model: string
  messages: string
  user: string
  assistant: string
  toolCalls: string
  turns: string
  turn: string
  role: string
  preview: string
  finalOutput: string
  /** AI-enhanced executive summary section heading. */
  summary: string
  insights: string
  /** Fallbacks. */
  untitled: string
  unknown: string
}

/** Re-export the workflow def alias used by callers building a source. */
export type { VisualWorkflow }
