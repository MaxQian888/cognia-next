import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { HostSession } from "../sessions/types.ts"
import { restartReason } from "../sessions/lifecycle.ts"

/** A retained-context probe is only a hint until admission checks its identity. */
export function retainedRuntimeSendIsSafe(
  existing: HostSession | undefined,
  options?: SendOptions
) {
  if (typeof options?.expectedRuntimeSessionId !== "string") return true
  return (
    !!existing &&
    existing.sdkSessionId === options.expectedRuntimeSessionId &&
    existing.q?.closed !== true &&
    restartReason(existing, options) === null
  )
}

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
    ...(options?.initialConversation ? { initialConversation: options.initialConversation } : {}),
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
