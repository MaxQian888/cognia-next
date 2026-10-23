export type {
  PluginAgentTurnRequest,
  PluginAgentTurnDenial,
  PluginAgentTurnResult,
  PluginSeededSessionInput,
  PluginSeededSessionResult,
} from "@cognia/plugin-contract/api/agent-turn"

export class PluginAgentTurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginAgentTurnError"
  }
}

/** Runtime calls are governed through `ctx.agent` and `ctx.session`. */
