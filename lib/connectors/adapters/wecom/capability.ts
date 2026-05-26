import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags declared by the WeCom 智能机器人 (AI bot) long-connection
 * adapter.
 *
 * The 智能机器人 channel (`wss://openws.work.weixin.qq.com`) supports:
 *   - send.text / send.markdown — `aibot_respond_msg` / `aibot_send_msg`
 *     `msgtype: "text" | "markdown" | "stream"`. Markdown caps at 20 480 bytes.
 *   - send.image / send.voice / send.video / send.file — via the 3-step
 *     `aibot_upload_media_*` chunked upload → `media_id` reference.
 *   - send.card — interactive `template_card` (button_interaction) frames.
 *   - send.a2ui — A2UI surfaces project onto `template_card` (buttons) when
 *     possible and always carry a `plainTextMirror` so degradation to
 *     markdown/text is guaranteed.
 *
 * Intentionally absent:
 *   - `edit` — the protocol has no generic message-edit frame
 *     (`aibot_respond_update_msg` only updates an in-flight template card).
 *   - `delete` — no message-recall frame.
 *   - `typing` — no typing indicator.
 *   - `history.fetch` — no history-pull frame on the long connection.
 *
 * Kept in alphabetical order for stable diffs.
 */
export const WECOM_CAPS: readonly Capability[] = [
  "send.a2ui",
  "send.card",
  "send.file",
  "send.image",
  "send.markdown",
  "send.text",
  "send.video",
  "send.voice",
] as const

/**
 * A2UI capability matrix for the WeCom adapter.
 *
 * Display + layout primitives project natively into the markdown body
 * (Text / Link / Divider / Badge) or a `template_card` header (Card / Alert).
 * `Button` maps to `template_card` `button_interaction` actions — the one
 * interactive component WeCom delivers a callback for (`template_card_event`),
 * so it is `native`. Every other interactive component (Select, Checkbox,
 * TextField, …) has no native template-card analogue and degrades to the
 * surface's `plainTextMirror` appended to the markdown body, so they default
 * to `fallback` via {@link buildA2UICapabilityMatrix}.
 */
export const WECOM_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Image: "native",
  Link: "native",
  Divider: "native",
  Badge: "native",
  Alert: "native",
  Card: "native",
  Button: "native",
})
