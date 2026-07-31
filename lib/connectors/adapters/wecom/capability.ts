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
 * `Button` maps to `template_card` `button_interaction` actions — the one
 * interactive component WeCom delivers a callback for (`template_card_event`)
 * — so it is `native`.
 *
 * `Text` / `Alert` / `Card` are kept `native` with an honest caveat: the
 * a2ui-mapper only projects them into the template_card header (title/desc)
 * when the surface carries at least one Button; otherwise their content still
 * reaches the user at full fidelity through the surface's `plainTextMirror`
 * in the markdown body. They are deliberately NOT `"simulated"` — the
 * build-options prompt (`buildCapabilityPromptSection`) describes simulated
 * kinds as "multi-step UX, do not assume a synchronous reply", which would
 * wrongly warn the assistant off plain display primitives and needlessly
 * degrade the evaluator's `worstCase` for ordinary card surfaces.
 *
 * `Image` / `Link` / `Divider` / `Badge` are `fallback`: the mapper never
 * projects them into a template_card — they survive only as plain text via
 * `plainTextMirror`. Every other interactive component (Select, Checkbox,
 * TextField, …) also defaults to `fallback` via
 * {@link buildA2UICapabilityMatrix}.
 */
export const WECOM_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Alert: "native",
  Card: "native",
  Button: "native",
  Image: "fallback",
  Link: "fallback",
  Divider: "fallback",
  Badge: "fallback",
})
