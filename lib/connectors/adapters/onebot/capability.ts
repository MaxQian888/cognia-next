import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags declared by the OneBot adapter.
 *
 * OneBot v11/v12 supports: send.text, send.image, send.voice, send.video,
 * send.file, send.reply, send.mention (at), send.emoji (face), delete,
 * history.fetch (get_msg_history), and forward (merged-forward send via the
 * NapCat send_group/private_forward_msg extension). No native edit or typing.
 *
 * `send.reaction` is declared because NapCat/LLOneBot ship the
 * `set_msg_emoji_like` extension; the adapter's `addReaction` /
 * `removeReaction` pair (`set: true` / `set: false`) is gated at runtime on
 * the upstream probe (`implMetadata.features`) so unsupported upstreams fail
 * honestly.
 *
 * Kept in alphabetical order for stable diffs.
 *
 * NOTE: `send.markdown` and `send.edit` are intentionally absent — OneBot has
 * neither native protocol support. The adapter exposes `send.a2ui` because
 * A2UI surfaces always carry a `plainTextMirror`, so degradation to the most
 * basic OneBot segments (text + image + at + reply) is always available.
 */
export const ONEBOT_CAPS: readonly Capability[] = [
  "delete",
  "forward",
  "history.fetch",
  "send.a2ui",
  "send.emoji",
  "send.file",
  "send.image",
  "send.mention",
  "send.reaction",
  "send.reply",
  "send.text",
  "send.video",
  "send.voice",
] as const

/**
 * A2UI capability matrix for the OneBot adapter (G3.5).
 *
 * OneBot v11 / v12 has no native interactive component segments — no
 * buttons, no forms, no cards. The mapper (`buildOneBotA2UISegments`)
 * projects only Text / Link / Image / Divider / Card title / Alert
 * natively; every interactive component flattens into `plainTextMirror`
 * appended as an "Available actions" tail so users still see the
 * options that would have been buttons.
 */
export const ONEBOT_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Image: "native",
  Link: "native",
  Divider: "native",
  Card: "native",
  Alert: "native",
})
