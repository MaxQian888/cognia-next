import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags for the personal-WeChat (iLink) adapter.
 *
 * iLink is a plain-text personal-account channel: no markdown rendering, no
 * interactive components, no message edit/delete, and — critically — no
 * proactive send (every reply must echo an inbound `context_token`). Outbound
 * is text-only in v1: outbound media would require AES-128-ECB *encryption* +
 * the CDN upload handshake, so image/voice/file/video segments degrade to a
 * text marker on send (inbound media is still received and, for images,
 * decrypted for the model).
 *
 * `send.a2ui` is declared because A2UI surfaces always carry a
 * `plainTextMirror`, so they degrade safely to text.
 */
export const WECHAT_PERSONAL_CAPS: readonly Capability[] = ["send.a2ui", "send.text"] as const

/**
 * Every A2UI component degrades to `plainTextMirror` — iLink renders only
 * plain text. Text/Link map cleanly; interactive kinds fall through to the
 * mirror via {@link buildA2UICapabilityMatrix}'s `fallback` default.
 */
export const WECHAT_PERSONAL_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Link: "native",
  Divider: "native",
})
