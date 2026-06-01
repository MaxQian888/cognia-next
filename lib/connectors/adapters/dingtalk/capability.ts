import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags declared by the DingTalk (钉钉) adapter.
 *
 * DingTalk's bot surface is **markdown-first**: outbound goes through the
 * OpenAPI proactive-send endpoints (`/v1.0/robot/oToMessages/batchSend` for
 * 1:1, `/v1.0/robot/groupMessages/send` for group) with the documented
 * `sampleText` / `sampleMarkdown` message templates. Markdown (headings,
 * bold/italic, links, lists, quotes, images) renders natively.
 *
 * What DingTalk does NOT support on the bot surface (kept off the matrix):
 *   - `edit` / `delete`: no public API to edit or retract a sent bot message.
 *   - `typing`: no typing-indicator API.
 *   - `fetchHistory`: the robot surface has no message-timeline read.
 *   - `send.reaction` / threads: not exposed to bots.
 *   - `send.mention` as a real ping: the OpenAPI proactive `msgParam` carries
 *     no reliable `at` object, so an @-mention renders as visible `@name`
 *     text but does not guarantee a notification — we do NOT claim it.
 *
 * Inbound: DingTalk Stream Mode only delivers messages directed at the bot
 * (1:1 chats, or group messages that @-mention the bot), so every inbound
 * event is treated as `selfMentioned`.
 *
 * Kept in alphabetical order for stable diffs.
 */
export const DINGTALK_CAPS: readonly Capability[] = [
  "send.a2ui",
  "send.markdown",
  "send.text",
] as const

/**
 * A2UI capability matrix for the DingTalk adapter (v1 — actionCard/markdown
 * projection, no pre-published interactive-card template).
 *
 * Native (rendered into the `sampleMarkdown` body):
 *   - Text / Link / Divider / Card / Alert / Image: standard DingTalk markdown
 *     (headings, `**bold**`, `[text](url)`, `![alt](url)`, `> quote`, `---`).
 *   - Row / Column / List: layout-only; the mapper walks children and emits
 *     grouped markdown lines.
 *
 * Simulated (functional, but degraded vs. a true inline widget):
 *   - Button: a button carrying an `href`/`url` renders as a clickable
 *     markdown link (works); a callback-only button (action id, no url) cannot
 *     round-trip in v1 because actionCard/markdown buttons do not raise a
 *     Stream card callback — it renders in an "操作" list for the user to type
 *     back. Full inline interactive callbacks require the advanced
 *     interactive-card template (deferred — see the adapter README).
 *
 * Fallback (rendered via `plainTextMirror`):
 *   - Select / RadioGroup / TextField / TextArea / Checkbox / Slider /
 *     DatePicker / Table / Chart and every overlay widget. These need the
 *     advanced interactive card to be functional, so v1 degrades them to the
 *     plain-text mirror rather than overclaiming.
 */
export const DINGTALK_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Link: "native",
  Divider: "native",
  Card: "native",
  Alert: "native",
  Image: "native",
  Row: "native",
  Column: "native",
  List: "native",
  Button: "simulated",
})
