/**
 * The plugin contract's share of `lib/ai/effort-surface-session.ts`, which re-exports these.
 */

import type { ChatSession } from "@cognia/agent-config-types"

/**
 * The session columns the ladder reads. The external-agent columns are
 * optional so a caller holding only the core three still gets an answer; it
 * then describes the agent's default model, as a new conversation would.
 */
export type EffortSessionColumns = Pick<ChatSession, "id" | "model" | "providerOverride"> &
  Partial<
    Pick<
      ChatSession,
      "externalAgentModels" | "externalAgentSession" | "externalAgentGatewaySessions"
    >
  >
