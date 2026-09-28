import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { SendOptions } from "../../shared/wire/inbound.ts"

export function providerVisibleSendPayloadIsSafe({
  prompt,
  options,
}: {
  prompt?: unknown
  options?: SendOptions
}) {
  const sdk = options?.claudeAgentSdk
  return hasNoLeakingPiiDeep({
    prompt,
    systemPrompt: options?.systemPrompt,
    appendSystemPrompt: options?.appendSystemPrompt,
    ...(options?.agents ? { agents: options.agents } : {}),
    ...(options?.pluginTools ? { pluginTools: options.pluginTools } : {}),
    ...(sdk
      ? {
          claudeAgentSdk: {
            outputFormat: sdk.outputFormat,
            permissionPromptToolName: sdk.permissionPromptToolName,
            planModeInstructions: sdk.planModeInstructions,
            plugins: sdk.plugins,
            skills: sdk.skills,
            toolAliases: sdk.toolAliases,
            toolConfig: sdk.toolConfig,
            tools: sdk.tools,
          },
        }
      : {}),
  })
}
