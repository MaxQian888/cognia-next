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
 * Media (`send.image` / `send.voice` / `send.video` / `send.file`) is native:
 * the TS adapter asks the Tauri media-upload command to PUT/POST bytes to the
 * homeserver media repository, then sends `m.image` / `m.file` / `m.audio` /
 * `m.video` room events that reference the returned `mxc://` URI.
 *
 * Kept in alphabetical order for stable diffs.
 */
export const MATRIX_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "send.a2ui",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reaction",
  "send.reply",
  "send.text",
  "send.thread",
  "send.video",
  "send.voice",
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
 *   - Image: an A2UI `Image` sub-component inside a surface is NOT uploaded to
 *     the media repo — `a2uiToMatrixHtml` degrades it to an `[alt]` text
 *     placeholder. (The native upload pipeline described above applies only to
 *     top-level `image` MESSAGE segments, not A2UI Image nodes.)
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
  // A2UI Image degrades to an `[alt]` text placeholder in a2uiToMatrixHtml —
  // it is not uploaded as native media (that path is only for top-level image
  // message segments). Declaring it "native" mislead the assistant into
  // emitting images that render as bare `[alt]` text for the recipient.
  Image: "fallback",
})
