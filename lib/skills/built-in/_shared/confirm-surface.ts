/**
 * Standard HITL confirm card shared by every built-in skill family.
 *
 * Extracted verbatim from `lark/_helpers.ts` (ADR-0026) when the
 * platform-neutral `im.*` family landed (W2 multi-bot) — the card is not
 * Lark-specific; each adapter's A2UI bridge projects it natively.
 * `lark/_helpers.ts` re-exports it so existing importers are untouched.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"

/**
 * Two buttons (Confirm / Cancel) — the dispatcher's binding looks up
 * `Confirm`'s action by component id.
 *
 *   - `title` — short headline, e.g. "Create calendar event"
 *   - `summary` — one or two sentences describing what will change
 *   - `details` — optional key/value rows shown beneath the summary
 */
export function buildConfirmSurface(input: {
  surfaceId: string
  title: string
  summary: string
  details?: ReadonlyArray<{ label: string; value: string }>
  confirmLabel?: string
  cancelLabel?: string
}): A2UISegmentContent {
  const detailRows = (input.details ?? []).map((d, i) => ({
    component: "Text",
    props: { text: `**${d.label}**: ${d.value}` },
    id: `detail_${i}`,
  }))
  return {
    rootId: input.surfaceId,
    surfaceType: "inline",
    title: input.title,
    components: {
      [input.surfaceId]: {
        component: "Card",
        props: { title: input.title },
        children: ["summary", ...detailRows.map((r) => r.id), "actions"],
      },
      summary: {
        component: "Text",
        props: { text: input.summary },
      },
      ...Object.fromEntries(detailRows.map((r) => [r.id, r])),
      actions: {
        component: "Row",
        children: ["btn_confirm", "btn_cancel"],
      },
      btn_confirm: {
        component: "Button",
        props: {
          label: input.confirmLabel ?? "Confirm",
          variant: "primary",
          action: { type: "button", value: "confirm" },
        },
      },
      btn_cancel: {
        component: "Button",
        props: {
          label: input.cancelLabel ?? "Cancel",
          variant: "secondary",
          action: { type: "button", value: "cancel" },
        },
      },
    },
    dataModel: {},
  }
}
