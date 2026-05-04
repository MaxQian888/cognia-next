// Dispatch entry point — picks the right runner based on the provider id.
//
// Returns the same `Session` shape regardless of provider:
//   { q, pushUserMessage, closeInput, pendingApprovals }
//
// `pendingApprovals` is empty for non-Anthropic providers in P2 because tool-
// calling parity hasn't shipped yet. The composer disables non-Anthropic
// selection when the active character has `allowedTools` set so users never
// hit a silent capability mismatch.

import { dispatchAnthropic } from "./anthropic.mjs"
import { dispatchAiSdk } from "./ai-sdk.mjs"

/**
 * @param {{
 *   sessionId: string,
 *   firstPrompt: any,
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   log: (level: "info"|"warn"|"error", message: string) => void,
 * }} params
 */
export function dispatch(params) {
  const provider = params.sendOptions.provider ?? "anthropic"
  if (provider === "anthropic") {
    return dispatchAnthropic(params)
  }
  return dispatchAiSdk({ ...params, provider })
}
