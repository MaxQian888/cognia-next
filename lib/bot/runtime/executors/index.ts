/**
 * The executor table. One entry per `PluginBotExecutor`, exhaustive by type,
 * so a new executor cannot be declared without something to run it.
 */

import type { PluginBotExecutor } from "@/types/plugin/plugin-bot"

import { runAgentTurnBot } from "./agent-turn"
import { runHandlerBot } from "./handler"
import { runSquadBot } from "./squad"
import type { BotExecutorFn } from "./types"
import { runWorkflowBot } from "./workflow"

export const BOT_EXECUTORS: Record<PluginBotExecutor, BotExecutorFn> = {
  workflow: runWorkflowBot,
  squad: runSquadBot,
  "agent-turn": runAgentTurnBot,
  handler: runHandlerBot,
}

export { BotExecutorUnavailableError } from "./types"
export type { BotExecutorContext, BotExecutorFn } from "./types"
export { createWorkflowBotExecutor, botTriggeredFrom } from "./workflow"
export { createSquadBotExecutor, squadObjective } from "./squad"
export { createAgentTurnBotExecutor, agentTurnPrompt } from "./agent-turn"
export { runHandlerBot } from "./handler"
