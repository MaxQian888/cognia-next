// Dispatch entry point — picks the right runner based on the provider id.
//
// Returns the same `Session` shape regardless of provider:
//   { q, pushUserMessage, closeInput, pendingApprovals, pendingPluginToolCalls }
//
// Both runners support tool-calling (ADR-0043): the non-Anthropic path bridges
// built-in + plugin tools to native AI SDK tools and gates execution through the
// same `permission_request` round-trip (`pendingApprovals`). Plugin tools
// round-trip through `pendingPluginToolCalls`. A2UI remains Anthropic-only.

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
