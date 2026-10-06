import type { ExternalAgentMessage } from "@/types/agent/external-agent"

import { promptInputPassesGate } from "@cognia/agent-runtime-kit/prompt-gate"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

/**
 * Inspect provider-visible prompt content before protocols hide text inside
 * base64 transport fields that the structural PII detector cannot decode.
 * The decoding lives in `@cognia/agent-runtime-kit/prompt-gate` (ADR-0217);
 * this binds it to the app's PII gate.
 */
export function hasNoLeakingExternalAgentPromptInput(
  message: ExternalAgentMessage,
  metadata?: Record<string, unknown>
): boolean {
  return promptInputPassesGate(message, hasNoLeakingPiiDeep, metadata)
}
