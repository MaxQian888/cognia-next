import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags declared by the Discord adapter.
 *
 * Kept in alphabetical order for stable diffs. G3.2 added `send.voice`
 * (multipart upload via `voice-upload.ts`) plus the full A2UI projection.
 */
export const DISCORD_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "send.a2ui",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
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
 *   - DatePicker / TimePicker / Slider / Table / Chart / DataExplorer.
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
})
