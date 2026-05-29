import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags for the QQ Official Bot adapter.
 *
 * QQ's open messaging API delivers plain text (`msg_type: 0`) for group / C2C /
 * channel / direct messages, with passive replies (`msg_id`) free inside the
 * reply window. Markdown and interactive keyboards exist but require
 * per-template review on the QQ console, so they are out of scope for v1 —
 * markdown segments degrade to text via the default chain, which is honest
 * about what the adapter actually delivers. Outbound media (rich media upload)
 * is also deferred.
 */
export const QQ_OFFICIAL_CAPS: readonly Capability[] = ["send.reply", "send.text"] as const

/**
 * A2UI matrix — every component falls back to `plainTextMirror`. QQ's
 * approved-template requirement for buttons/markdown means we cannot project
 * interactive surfaces natively in v1; the assistant stays free to emit A2UI
 * and it degrades to the text mirror.
 */
export const QQ_OFFICIAL_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({})
