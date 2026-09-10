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
 * supports encrypted image, video, and file uploads. Audio is delivered as a
 * file with an explicit voice-to-file downgrade.
 *
 * `send.a2ui` is declared because A2UI surfaces always carry a
 * `plainTextMirror`, so they degrade safely to text.
 */
export const WECHAT_PERSONAL_CAPS: readonly Capability[] = [
  "send.a2ui",
  "send.text",
  "send.image",
  "send.video",
  "send.file",
] as const

/**
 * iLink renders plain text. Buttons are simulated with scoped numeric
 * replies (up to nine per outbound message); value-taking controls remain
 * text fallbacks because numeric callbacks cannot provide their values.
 */
export const WECHAT_PERSONAL_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Button: "simulated",
  Text: "native",
  Link: "native",
  Divider: "native",
})
