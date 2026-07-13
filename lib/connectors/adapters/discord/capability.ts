import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags declared by the Discord adapter.
 *
 * Kept in alphabetical order for stable diffs. G3.2 added `send.voice`
 * (voice-flagged Discord message fallback via `voice-upload.ts`) plus the full
 * A2UI projection. Native multipart upload still depends on a future Tauri
 * upload bridge.
 */
// GAP: webhook-mode static capability drift — this list is declared once per
// adapter type, but in `transportMode: "webhook"` the gateway-only features
// (presence.status, typing, live message events feeding history consumers)
// don't apply; splitting the matrix per transport is a separate follow-up.
export const DISCORD_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  // `GET /channels/{channel.id}/messages?limit=N&before=...` — added at
  // ADR-0009 v41 / A2.b. Cursor-paginated history walk via the adapter
  // `fetchHistory(conversationKey, opts)` async generator. Each page
  // returns newest-first; the cursor for the next (older) page is the
  // oldest message id in the previous response.
  "history.fetch",
  // `PUT|DELETE /channels/{channel}/messages/pins/{message}` (current
  // endpoint; the bare `/channels/{c}/pins/{m}` form is deprecated) +
  // gateway op 3 Custom Status.
  "pin",
  "presence.status",
  "send.a2ui",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  // `PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`
  // — see A2 in the IM connector gap-closure plan (ADR-0009 v41). The
  // Discord REST endpoint operates per-emoji and requires the emoji URI-
  // encoded (`reactions/%F0%9F%91%8D/@me` for `👍`); the helper takes care
  // of that so call sites pass the raw unicode character.
  "send.reaction",
  "send.reply",
  "send.text",
  "send.thread",
  "send.video",
  "send.voice",
  "typing",
] as const

/**
 * A2UI capability matrix for the Discord adapter (G3.2).
 *
 * Native rendering (via `buildDiscordA2UIPayload`):
 *   - Text / Link / Divider / Card / Alert: embeds with markdown body.
 *   - Image: `embed.image.url` (or nested inside the current Card embed).
 *   - Button / ButtonGroup: ActionRow + Button components with
 *     callback bindings in `connectorCallbackBindings`.
 *   - Select / RadioGroup: ActionRow + SelectMenu (component_type=3).
 *   - Row / Column / List: layout-only; children traverse.
 *
 * Fallback (renders via `plainTextMirror`):
 *   - TextField / TextArea / Checkbox / Radio: Discord exposes these
 *     only through Modals — modals are interaction-launched, not
 *     assistant-pushed, so a surface-as-message projection can't host
 *     them.
 *   - DatePicker / TimePicker / Slider / Table / Chart.
 *   - Tabs / Accordion / Dialog / Drawer / Sheet / Sidebar / Collapsible.
 */
export const DISCORD_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Image: "native",
  Link: "native",
  Divider: "native",
  Card: "native",
  Alert: "native",
  Button: "native",
  Select: "native",
  RadioGroup: "native",
  Row: "native",
  Column: "native",
  List: "native",
  // ADR-0026 Track B — TextField / TextArea / Dialog round-trip via
  // `interaction.showModal` two-hop. The mapper emits a Button whose
  // `custom_id` is bound (`kind: "modal_open"`) to the surface's input
  // children; on click, the adapter responds with InteractionResponse
  // type 9 (MODAL) carrying TextInput components. Modal submissions
  // arrive as `MESSAGE_COMPONENT` with `actionType: "submit"` and are
  // routed through the standard binding lookup.
  TextField: "simulated",
  TextArea: "simulated",
  Dialog: "simulated",
})
