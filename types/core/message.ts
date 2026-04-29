/**
 * Minimal core message types — stubbed for the External Agent migration.
 *
 * Cognia ships a much richer Message/Part type system here. cognia-next's
 * chat layer uses `UIMessage` from `ai` (vercel-ai-sdk) instead, so we
 * only need to expose the names that the migrated agent code references
 * (`ToolState`, `MessageRole`). Replace with a richer model later if/when
 * cognia-next adopts the multi-part message shape.
 */

export type MessageRole = "user" | "assistant" | "system" | "tool"

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "output-denied"
  | "approval-requested"
  | "approval-responded"
