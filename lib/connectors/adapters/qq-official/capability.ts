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
 *
 * Scene-limited mutations (the flag is declared platform-wide; the adapter
 * throws `unsupported` outside the scene):
 *   - `delete`        — all four scenes (group / c2c / channel / direct recall).
 *   - `typing`        — C2C ONLY (`msg_type: 6 input_notify` passive reply);
 *                       silently no-ops elsewhere.
 *   - `send.reaction` — guild `channel` scene ONLY
 *                       (`PUT/DELETE /channels/{c}/messages/{m}/reactions/{type}/{id}`).
 * Absent on purpose: `edit` and `history.fetch` — the QQ bot API has neither
 * a message-edit nor a history-read endpoint.
 */
export const QQ_OFFICIAL_CAPS: readonly Capability[] = [
  "send.reply",
  "send.text",
  "delete",
  "typing",
  "send.reaction",
] as const

/**
 * A2UI matrix — every component falls back to `plainTextMirror`. QQ's
 * approved-template requirement for buttons/markdown means we cannot project
 * interactive surfaces natively in v1; the assistant stays free to emit A2UI
 * and it degrades to the text mirror.
 */
export const QQ_OFFICIAL_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({})
