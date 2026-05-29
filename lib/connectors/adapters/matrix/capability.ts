import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags declared by the Matrix adapter.
 *
 * Matrix (client-server API r0.6+) is a rich-text-first protocol: messages
 * carry an `org.matrix.custom.html` `formatted_body` alongside the plain
 * `body`, so markdown, links, lists, and quotes all render natively. Edits
 * (`m.replace`), redactions (delete), reactions (`m.annotation`), replies
 * (`m.in_reply_to`), threads (`m.thread`), and typing notifications are all
 * first-class.
 *
 * `send.image` / `send.file` are intentionally omitted: outbound media
 * requires uploading to the homeserver's media repo (`/_matrix/media`) with
 * a binary body, which the string-only Tauri HTTP proxy cannot carry in
 * Phase 1. Image / file segments degrade to a link in the message body (the
 * default degrade chain → `text`), which is honest about what the adapter
 * actually delivers. Outbound media upload is tracked for the Phase 4 media
 * pipeline.
 *
 * Kept in alphabetical order for stable diffs.
 */
export const MATRIX_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "send.a2ui",
  "send.markdown",
  "send.mention",
  "send.reaction",
  "send.reply",
  "send.text",
  "send.thread",
  "typing",
] as const

/**
 * A2UI capability matrix for the Matrix adapter.
 *
 * Native (rendered via `org.matrix.custom.html` `formatted_body`):
 *   - Text / Link / Divider / Card / Alert: HTML blockquote / heading /
 *     horizontal-rule / anchor.
 *   - Row / Column / List: layout-only; the mapper walks children and emits
 *     `<ul>` / line groups.
 *
 * Simulated (functional, multi-step UX via reply-correlation):
 *   - Button / Select / RadioGroup: rendered as a numbered list inside the
 *     HTML body. A `force_reply`-style binding is persisted against the sent
 *     event id; when the user *replies* to the surface message, the inbound
 *     reply is correlated back to the surface and routed through
 *     `ConnectorBus.dispatchConnectorCallback` as an `input` action. The
 *     interaction works but takes a tap-reply rather than an inline click.
 *   - TextField / TextArea: same reply-correlation path.
 *
 * Fallback (rendered via `plainTextMirror`):
 *   - Image: clients block remote `<img>` `src` by default and outbound
 *     media upload is deferred, so an Image projects to its alt text.
 *   - Everything else (Checkbox / Slider / DatePicker / Table / Chart /
 *     overlay widgets) degrades to the plain-text mirror.
 */
export const MATRIX_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Link: "native",
  Divider: "native",
  Card: "native",
  Alert: "native",
  Row: "native",
  Column: "native",
  List: "native",
  Button: "simulated",
  Select: "simulated",
  RadioGroup: "simulated",
  TextField: "simulated",
  TextArea: "simulated",
  Image: "fallback",
})
